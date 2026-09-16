import { describe, expect, it } from "vitest";
import { ResponsesStore } from "../../src/openai/responses-store.js";

describe("ResponsesStore", () => {
  it("replays idempotent creates only within the same owner", () => {
    const store = new ResponsesStore();
    const first = store.create("client:a", "folderforge-agent", {}, "key-1");
    const replay = store.create("client:a", "folderforge-agent", {}, "key-1");
    expect(replay.record.id).toBe(first.record.id);
    expect(() =>
      store.create("client:b", "folderforge-agent", {}, "key-1"),
    ).not.toThrow();
    expect(() => store.get(first.record.id, "client:b")).toThrow(
      "response_not_found",
    );
  });

  it("expires terminal records and evicts the oldest terminal record at the bound", async () => {
    const store = new ResponsesStore({ maxRecords: 1, ttlMs: 2 });
    const expired = store.create("client:a", "folderforge-agent", {});
    store.update(expired.record.id, "client:a", "completed");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const retained = store.create("client:a", "folderforge-agent", {});
    expect(() => store.get(expired.record.id, "client:a")).toThrow(
      "response_not_found",
    );
    store.update(retained.record.id, "client:a", "completed");
    const newest = store.create("client:a", "folderforge-agent", {});
    expect(() => store.get(retained.record.id, "client:a")).toThrow(
      "response_not_found",
    );
    expect(store.get(newest.record.id, "client:a").record.status).toBe(
      "queued",
    );
  });

  it("records deltas, terminal state, cancellation, and cursor polling", () => {
    const store = new ResponsesStore();
    const response = store.create("client:a", "folderforge-agent", {});
    store.update(response.record.id, "client:a", "in_progress");
    store.appendDelta(response.record.id, "client:a", "msg_1", "hello");
    const cancelled = store.cancel(response.record.id, "client:a");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.output_text).toBe("hello");
    const events = store.eventsSince(response.record.id, "client:a");
    expect(events.events.map((event) => event.type)).toEqual([
      "response.in_progress",
      "response.output_text.delta",
      "response.cancelled",
    ]);
    expect(
      store.eventsSince(response.record.id, "client:a", 2).events,
    ).toHaveLength(1);
  });
});
