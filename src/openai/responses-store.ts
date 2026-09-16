import {
  newResponseId,
  responseSnapshot,
  type ResponseRecord,
  type ResponsesEvent,
  type ResponseStatus,
} from "./responses-compat.js";

export interface ResponseHandle {
  record: ResponseRecord;
  events: ResponsesEvent[];
  ownerId: string;
  idempotencyKey?: string;
  requestFingerprint?: string;
  createdAtMs: number;
  terminalAtMs: number | null;
  /** True when create() returned an existing idempotent response. */
  isReplay: boolean;
  cancelRequested: boolean;
  abortController?: AbortController;
}

export interface ResponsesStoreOptions {
  /** Maximum number of terminal/in-flight records retained in memory. */
  maxRecords?: number;
  /** How long terminal records remain available for polling/replay. */
  ttlMs?: number;
}

/** Bounded owner-aware response registry used by both JSON polling and SSE. */
export class ResponsesStore {
  private readonly records = new Map<string, ResponseHandle>();
  private readonly idempotency = new Map<string, string>();
  private readonly idempotencyFingerprints = new Map<string, string>();
  private readonly maxRecords: number;
  private readonly ttlMs: number;

  constructor(options: ResponsesStoreOptions = {}) {
    this.maxRecords = Math.max(1, Math.floor(options.maxRecords ?? 1_000));
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? 30 * 60_000));
  }

  private remove(id: string): void {
    const handle = this.records.get(id);
    if (!handle) return;
    this.records.delete(id);
    if (handle.idempotencyKey) {
      const key = `${handle.ownerId}:${handle.idempotencyKey}`;
      if (this.idempotency.get(key) === id) {
        this.idempotency.delete(key);
        this.idempotencyFingerprints.delete(key);
      }
    }
  }

  private prune(now = Date.now()): void {
    for (const [id, handle] of this.records) {
      if (
        handle.terminalAtMs !== null &&
        handle.terminalAtMs + this.ttlMs <= now
      ) {
        this.remove(id);
      }
    }
    if (this.records.size <= this.maxRecords) return;
    const terminal = [...this.records.values()]
      .filter((handle) => handle.terminalAtMs !== null)
      .sort(
        (left, right) =>
          (left.terminalAtMs ?? left.createdAtMs) -
          (right.terminalAtMs ?? right.createdAtMs),
      );
    for (const handle of terminal) {
      if (this.records.size <= this.maxRecords) break;
      this.remove(handle.record.id);
    }
  }

  create(
    ownerId: string,
    model: string,
    metadata: Record<string, string>,
    idempotencyKey?: string,
    requestFingerprint?: string,
  ): ResponseHandle {
    this.prune();
    if (idempotencyKey) {
      const idempotencyId = `${ownerId}:${idempotencyKey}`;
      const existingId = this.idempotency.get(idempotencyId);
      if (existingId) {
        const existingFingerprint =
          this.idempotencyFingerprints.get(idempotencyId);
        if (
          requestFingerprint !== undefined &&
          existingFingerprint !== undefined &&
          existingFingerprint !== requestFingerprint
        ) {
          throw new Error("idempotency_conflict");
        }
        return { ...this.get(existingId, ownerId), isReplay: true };
      }
    }
    const now = Date.now();
    const record: ResponseRecord = {
      id: newResponseId(),
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "queued",
      model,
      output: [],
      output_text: "",
      error: null,
      usage: null,
      metadata,
    };
    const handle: ResponseHandle = {
      record,
      events: [],
      ownerId,
      createdAtMs: now,
      terminalAtMs: null,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(requestFingerprint === undefined ? {} : { requestFingerprint }),
      isReplay: false,
      cancelRequested: false,
    };
    this.records.set(record.id, handle);
    if (idempotencyKey) {
      const idempotencyId = `${ownerId}:${idempotencyKey}`;
      this.idempotency.set(idempotencyId, record.id);
      if (requestFingerprint !== undefined) {
        this.idempotencyFingerprints.set(idempotencyId, requestFingerprint);
      }
    }
    return handle;
  }

  get(id: string, ownerId: string): ResponseHandle {
    this.prune();
    const handle = this.records.get(id);
    if (!handle || handle.ownerId !== ownerId)
      throw new Error("response_not_found");
    return handle;
  }

  update(
    id: string,
    ownerId: string,
    status: ResponseStatus,
    patch: Partial<
      Pick<ResponseRecord, "output" | "output_text" | "error" | "usage">
    > = {},
  ): ResponseRecord {
    const handle = this.get(id, ownerId);
    handle.record = { ...handle.record, ...patch, status };
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      handle.terminalAtMs ??= Date.now();
    }
    if (status === "completed") {
      handle.events.push({
        type: "response.output_text.done",
        item_id: `msg_${handle.record.id}`,
        text: handle.record.output_text,
        output_index: 0,
      });
    }
    const eventType =
      status === "completed"
        ? "response.completed"
        : status === "failed"
          ? "response.failed"
          : status === "cancelled"
            ? "response.cancelled"
            : status === "in_progress"
              ? "response.in_progress"
              : "response.created";
    handle.events.push({
      type: eventType,
      response: responseSnapshot(handle.record),
    } as ResponsesEvent);
    return responseSnapshot(handle.record);
  }

  appendDelta(
    id: string,
    ownerId: string,
    itemId: string,
    delta: string,
  ): void {
    const handle = this.get(id, ownerId);
    handle.record.output_text += delta;
    handle.events.push({
      type: "response.output_text.delta",
      item_id: itemId,
      delta,
      output_index: 0,
    });
  }

  bindAbortController(
    id: string,
    ownerId: string,
    controller: AbortController,
  ): void {
    const handle = this.get(id, ownerId);
    handle.abortController = controller;
  }

  cancel(id: string, ownerId: string): ResponseRecord {
    const handle = this.get(id, ownerId);
    if (
      handle.record.status === "queued" ||
      handle.record.status === "in_progress"
    ) {
      handle.cancelRequested = true;
      handle.abortController?.abort();
      return this.update(id, ownerId, "cancelled", {
        error: {
          code: "response_cancelled",
          message: "Response cancellation requested.",
        },
      });
    }
    return responseSnapshot(handle.record);
  }

  eventsSince(
    id: string,
    ownerId: string,
    cursor = 0,
  ): { cursor: number; events: ResponsesEvent[] } {
    const handle = this.get(id, ownerId);
    const safeCursor = Math.max(0, Math.min(cursor, handle.events.length));
    return {
      cursor: handle.events.length,
      events: handle.events
        .slice(safeCursor)
        .map((event) => JSON.parse(JSON.stringify(event)) as ResponsesEvent),
    };
  }
}
