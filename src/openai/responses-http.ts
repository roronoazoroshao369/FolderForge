import type { IncomingMessage, ServerResponse } from "node:http";
import {
  FOLDERFORGE_MODELS,
  modelById,
  normalizeResponseInput,
  sseEvent,
  type ResponsesRequest,
} from "./responses-compat.js";
import { ResponsesStore } from "./responses-store.js";

export interface ResponsesPrincipalContext {
  clientId?: string;
  sessionId?: string;
  taskId?: string;
  workflowId?: string;
}

export interface ResponsesHttpOptions {
  store: ResponsesStore;
  /** Executes one governed request. The callback must use ToolRegistry and must not bypass policy. */
  execute: (args: {
    ownerId: string;
    principalContext: ResponsesPrincipalContext;
    request: ResponsesRequest;
    responseId: string;
    signal: AbortSignal;
  }) => Promise<void>;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.byteLength;
    if (bytes > 1_048_576) throw new Error("request_body_too_large");
    chunks.push(part);
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_json_body");
  return value as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim();
  if (!normalized) return undefined;
  if (normalized.length > 256 || /[\r\n]/.test(normalized)) {
    throw new Error(`invalid_${name.replaceAll("-", "_")}`);
  }
  return normalized;
}

function principalContextFrom(
  req: IncomingMessage,
  metadata?: Record<string, string>,
): ResponsesPrincipalContext {
  const clientId = headerValue(req, "x-client-id");
  const sessionId = headerValue(req, "x-session-id");
  const taskId = headerValue(req, "x-task-id");
  const workflowId =
    headerValue(req, "x-implementation-workflow-id") ??
    (typeof metadata?.implementationWorkflowId === "string"
      ? metadata.implementationWorkflowId.trim()
      : undefined);
  if (taskId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taskId)) {
    throw new Error("invalid_x_task_id");
  }
  if (workflowId && !/^wf_[A-Za-z0-9]+$/.test(workflowId)) {
    throw new Error("invalid_implementation_workflow_id");
  }
  return {
    ...(clientId ? { clientId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(workflowId ? { workflowId } : {}),
  };
}

function requestFrom(value: Record<string, unknown>): ResponsesRequest {
  if (!("input" in value)) throw new Error("input_required");
  return value as unknown as ResponsesRequest;
}

export function createResponsesHttpHandler(
  options: ResponsesHttpOptions,
): (
  req: IncomingMessage,
  res: ServerResponse,
  ownerId: string,
) => Promise<boolean> {
  return async (req, res, ownerId) => {
    const url = new URL(req.url ?? "/", "http://folderforge.invalid");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      json(res, 200, { object: "list", data: FOLDERFORGE_MODELS });
      return true;
    }
    const responseMatch = /^\/v1\/responses\/([^/]+)(\/cancel)?$/.exec(
      url.pathname,
    );
    if (responseMatch && req.method === "GET" && !responseMatch[2]) {
      try {
        json(res, 200, options.store.get(responseMatch[1]!, ownerId).record);
      } catch {
        json(res, 404, { error: { code: "response_not_found" } });
      }
      return true;
    }
    if (
      responseMatch &&
      req.method === "POST" &&
      (responseMatch[2] === "/cancel" ||
        url.searchParams.get("action") === "cancel")
    ) {
      try {
        json(res, 200, options.store.cancel(responseMatch[1]!, ownerId));
      } catch {
        json(res, 404, { error: { code: "response_not_found" } });
      }
      return true;
    }
    if (req.method !== "POST" || url.pathname !== "/v1/responses") return false;
    try {
      const request = requestFrom(await body(req));
      const principalContext = principalContextFrom(req, request.metadata);
      const model = modelById(request.model);
      normalizeResponseInput(request);
      const key =
        typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : undefined;
      const metadata = request.metadata ?? {};
      const fingerprint = JSON.stringify({ request, principalContext });
      const handle = options.store.create(
        ownerId,
        model.id,
        metadata,
        key,
        fingerprint,
      );
      const controller = new AbortController();
      if (!handle.isReplay)
        options.store.bindAbortController(
          handle.record.id,
          ownerId,
          controller,
        );
      if (request.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-store",
          connection: "keep-alive",
        });
        res.write(
          sseEvent({ type: "response.created", response: handle.record }),
        );
        let cursor = 0;
        let closed = false;
        const cancelActiveResponse = () => {
          try {
            const current = options.store.get(handle.record.id, ownerId).record;
            if (
              current.status === "queued" ||
              current.status === "in_progress"
            ) {
              options.store.cancel(handle.record.id, ownerId);
            }
          } catch {
            // The record may already have expired or been removed.
          }
        };
        const cleanup = () => {
          if (closed) return;
          closed = true;
          cancelActiveResponse();
          controller.abort();
          clearInterval(timer);
        };
        const terminal = new Set(["completed", "failed", "cancelled"]);
        const drain = () => {
          if (closed) return;
          try {
            const batch = options.store.eventsSince(
              handle.record.id,
              ownerId,
              cursor,
            );
            cursor = batch.cursor;
            for (const event of batch.events) res.write(sseEvent(event));
            const current = options.store.get(handle.record.id, ownerId).record;
            if (terminal.has(current.status)) {
              cleanup();
              res.end();
            }
          } catch {
            cleanup();
            res.end();
          }
        };
        req.on("aborted", cleanup);
        res.on("close", cleanup);
        const timer = setInterval(drain, 100);
        if (!handle.isReplay) {
          void options
            .execute({
              ownerId,
              principalContext,
              request,
              responseId: handle.record.id,
              signal: controller.signal,
            })
            .catch((error: unknown) => {
              try {
                const current = options.store.get(
                  handle.record.id,
                  ownerId,
                ).record;
                if (current.status !== "cancelled") {
                  options.store.update(handle.record.id, ownerId, "failed", {
                    error: {
                      code: "execution_failed",
                      message:
                        error instanceof Error ? error.message : String(error),
                    },
                  });
                }
              } catch {
                // The client may have disconnected after the response was cancelled.
              }
            });
        }
        return true;
      }
      req.on("aborted", () => {
        try {
          options.store.cancel(handle.record.id, ownerId);
        } catch {
          // The response may already be terminal or expired.
        }
      });
      if (!handle.isReplay) {
        await options.execute({
          ownerId,
          principalContext,
          request,
          responseId: handle.record.id,
          signal: controller.signal,
        });
      }
      json(res, 200, options.store.get(handle.record.id, ownerId).record);
    } catch (error) {
      const status =
        error instanceof Error && error.message === "idempotency_conflict"
          ? 409
          : 400;
      json(res, status, {
        error: {
          code: error instanceof Error ? error.message : "invalid_request",
          message: "Invalid Responses request.",
        },
      });
    }
    return true;
  };
}
