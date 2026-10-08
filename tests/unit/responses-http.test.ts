import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import {
  createResponsesHttpHandler,
  type ResponsesHttpOptions,
} from "../../src/openai/responses-http.js";
import { ResponsesStore } from "../../src/openai/responses-store.js";

type ExecuteFactory = (
  store: ResponsesStore,
) => ResponsesHttpOptions["execute"];

type Harness = {
  store: ResponsesStore;
  server: Server;
  baseUrl: string;
};

async function startHarness(factory: ExecuteFactory): Promise<Harness> {
  const store = new ResponsesStore();
  const handler = createResponsesHttpHandler({
    store,
    execute: factory(store),
  });
  const server = createServer((req, res) => {
    const ownerId =
      req.headers["x-test-owner"] === "owner:b" ? "owner:b" : "owner:a";
    void handler(req, res, ownerId).then((handled) => {
      if (!handled && !res.writableEnded) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("server did not bind");
  return { store, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeHarness(harness: Harness): Promise<void> {
  await new Promise<void>((resolve) => harness.server.close(() => resolve()));
}

async function post(
  baseUrl: string,
  path: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

describe("Responses HTTP handler", () => {
  it("lists models, executes JSON, replays idempotency, and rejects conflicts", async () => {
    let executions = 0;
    const harness = await startHarness(
      (store) =>
        async ({ ownerId, responseId }) => {
          executions += 1;
          store.update(responseId, ownerId, "in_progress");
          store.appendDelta(responseId, ownerId, `msg_${responseId}`, "done");
          store.update(responseId, ownerId, "completed");
        },
    );
    try {
      const models = await fetch(`${harness.baseUrl}/v1/models`);
      expect(models.status).toBe(200);
      expect(
        ((await models.json()) as { data: Array<{ id: string }> }).data[0]?.id,
      ).toBe("folderforge-agent");

      const payload = { model: "folderforge-agent", input: "hello" };
      const first = await post(harness.baseUrl, "/v1/responses", payload, {
        "idempotency-key": "same-key",
      });
      const replay = await post(harness.baseUrl, "/v1/responses", payload, {
        "idempotency-key": "same-key",
      });
      expect(first.response.status).toBe(200);
      expect(replay.response.status).toBe(200);
      expect(replay.body.id).toBe(first.body.id);
      expect(replay.body.status).toBe("completed");
      expect(replay.body.output_text).toBe("done");
      expect(executions).toBe(1);

      const conflict = await post(
        harness.baseUrl,
        "/v1/responses",
        { model: "folderforge-agent", input: "different" },
        { "idempotency-key": "same-key" },
      );
      expect(conflict.response.status).toBe(409);
      expect(conflict.body.error).toMatchObject({
        code: "idempotency_conflict",
      });

      const hidden = await fetch(
        `${harness.baseUrl}/v1/responses/${String(first.body.id)}`,
        {
          headers: { "x-test-owner": "owner:b" },
        },
      );
      expect(hidden.status).toBe(404);
    } finally {
      await closeHarness(harness);
    }
  });

  it("propagates client, session, task, and implementation workflow context", async () => {
    let captured:
      | {
          clientId?: string;
          sessionId?: string;
          taskId?: string;
          workflowId?: string;
        }
      | undefined;
    const harness = await startHarness(
      (store) =>
        async ({ ownerId, responseId, principalContext }) => {
          captured = principalContext;
          store.update(responseId, ownerId, "completed");
        },
    );
    try {
      const result = await post(
        harness.baseUrl,
        "/v1/responses",
        {
          model: "folderforge-agent",
          input: "context",
          metadata: { implementationWorkflowId: "wf_metadata" },
        },
        {
          "x-client-id": "codex-client",
          "x-session-id": "session-1",
          "x-task-id": "task-1",
          "x-implementation-workflow-id": "wf_header",
        },
      );
      expect(result.response.status).toBe(200);
      expect(captured).toEqual({
        clientId: "codex-client",
        sessionId: "session-1",
        taskId: "task-1",
        workflowId: "wf_header",
      });
    } finally {
      await closeHarness(harness);
    }
  });

  it("rejects malformed implementation workflow headers", async () => {
    const harness = await startHarness(() => async () => undefined);
    try {
      const result = await post(
        harness.baseUrl,
        "/v1/responses",
        { model: "folderforge-agent", input: "invalid" },
        { "x-implementation-workflow-id": "not-a-workflow" },
      );
      expect(result.response.status).toBe(400);
      expect(result.body.error).toMatchObject({
        code: "invalid_implementation_workflow_id",
      });
    } finally {
      await closeHarness(harness);
    }
  });

  it("keeps SSE connections open until terminal events and preserves event order", async () => {
    const harness = await startHarness(
      (store) =>
        async ({ ownerId, responseId }) => {
          store.update(responseId, ownerId, "in_progress");
          store.appendDelta(
            responseId,
            ownerId,
            `msg_${responseId}`,
            "streamed",
          );
          store.update(responseId, ownerId, "completed");
        },
    );
    try {
      const response = await fetch(`${harness.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "folderforge-agent",
          input: "hello",
          stream: true,
        }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      const events = [...text.matchAll(/^event: ([^\n]+)$/gm)].map(
        (match) => match[1],
      );
      expect(events).toEqual([
        "response.created",
        "response.in_progress",
        "response.output_text.delta",
        "response.output_text.done",
        "response.completed",
      ]);
      expect(text).toContain('"delta":"streamed"');
    } finally {
      await closeHarness(harness);
    }
  });

  it("disconnecting an idempotent SSE replay does not cancel the original response", async () => {
    let executions = 0;
    let originalAborted = false;
    let releaseWork: (() => void) | undefined;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const harness = await startHarness(
      (store) =>
        async ({ ownerId, responseId, signal }) => {
          executions += 1;
          store.update(responseId, ownerId, "in_progress");
          signal.addEventListener(
            "abort",
            () => {
              originalAborted = true;
            },
            { once: true },
          );
          await workGate;
          if (!signal.aborted) {
            store.appendDelta(responseId, ownerId, `msg_${responseId}`, "completed");
            store.update(responseId, ownerId, "completed");
          }
        },
    );
    let primaryReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const replayAbort = new AbortController();
    try {
      const payload = JSON.stringify({
        model: "folderforge-agent",
        input: "keep the original running",
        stream: true,
      });
      const headers = {
        "content-type": "application/json",
        "idempotency-key": "replay-does-not-own-original",
      };
      const primary = await fetch(`${harness.baseUrl}/v1/responses`, {
        method: "POST",
        headers,
        body: payload,
      });
      expect(primary.status).toBe(200);
      primaryReader = primary.body?.getReader();
      if (!primaryReader) throw new Error("missing primary SSE reader");
      const first = await primaryReader.read();
      const created = new TextDecoder().decode(first.value);
      const event = JSON.parse(
        created.match(/data: (\{.*\})/)?.[1] ?? "{}",
      ) as { response?: { id?: string } };
      const responseId = event.response?.id;
      if (!responseId) throw new Error("missing original response id");

      const replay = await fetch(`${harness.baseUrl}/v1/responses`, {
        method: "POST",
        headers,
        body: payload,
        signal: replayAbort.signal,
      });
      expect(replay.status).toBe(200);
      await replay.body?.getReader().read();
      replayAbort.abort();
      // Allow the server's res.close handler to observe replay disconnect.
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(executions).toBe(1);
      expect(harness.store.get(responseId, "owner:a").record.status).toBe(
        "in_progress",
      );
      expect(originalAborted).toBe(false);
    } finally {
      replayAbort.abort();
      releaseWork?.();
      await primaryReader?.cancel().catch(() => undefined);
      await closeHarness(harness);
    }
  });

  it("cancels an active SSE response through both cancellation routes", async () => {
    const harness = await startHarness(
      (store) =>
        async ({ ownerId, responseId, signal }) => {
          store.update(responseId, ownerId, "in_progress");
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
    );
    try {
      const response = await fetch(`${harness.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "folderforge-agent",
          input: "cancel me",
          stream: true,
        }),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing SSE body");
      const first = await reader.read();
      const firstText = new TextDecoder().decode(first.value);
      const event = JSON.parse(
        firstText.match(/data: (\{.*\})/)?.[1] ?? "{}",
      ) as { response?: { id?: string } };
      const responseId = event.response?.id;
      if (!responseId) throw new Error("missing response id");

      const cancelled = await post(
        harness.baseUrl,
        `/v1/responses/${responseId}/cancel`,
        {},
      );
      expect(cancelled.response.status).toBe(200);
      expect(cancelled.body.status).toBe("cancelled");

      let text = firstText;
      let next = await reader.read();
      while (!next.done) {
        text += new TextDecoder().decode(next.value);
        next = await reader.read();
      }
      expect(text).toContain("event: response.cancelled");

      const legacy = await post(
        harness.baseUrl,
        `/v1/responses/${responseId}?action=cancel`,
        {},
      );
      expect(legacy.response.status).toBe(200);
      expect(legacy.body.status).toBe("cancelled");
    } finally {
      await closeHarness(harness);
    }
  });
});
