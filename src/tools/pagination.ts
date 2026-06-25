/**
 * Shared pagination & truncation helpers (roadmap Q3 - token efficiency).
 *
 * Large read-style tool outputs (search hits, logs, file bodies) can blow an
 * agent's context window. These helpers give every reading tool a consistent
 * `offset` / `limit` / `maxBytes` contract and a uniform truncation envelope so
 * the agent always knows whether more data is available and how to fetch it.
 *
 * Conventions:
 *  - `offset` is 0-based; `limit` caps the number of returned items.
 *  - `maxBytes` caps the UTF-8 byte size of a returned string body.
 *  - When output is cut short, the tool sets `truncated: true` and returns a
 *    `nextOffset` (for item lists) so the caller can page forward.
 */

/** Standard pagination inputs accepted by reading tools. */
export interface PageParams {
  offset?: number;
  limit?: number;
  maxBytes?: number;
}

/** Envelope describing a paginated slice of items. */
export interface Page<T> {
  items: T[];
  /** Total number of items available before paging. */
  total: number;
  /** 0-based offset of the first returned item. */
  offset: number;
  /** Number of items returned in this page. */
  count: number;
  /** True when more items exist beyond this page. */
  truncated: boolean;
  /** Offset to pass next to continue, or null when exhausted. */
  nextOffset: number | null;
}

/** Default and ceiling page sizes; tools may override the default. */
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

/** Coerce a raw arg into a non-negative integer, or fall back. */
export function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/** Read and normalize pagination params from a raw args object. */
export function readPageParams(
  args: Record<string, unknown>,
  defaultLimit = DEFAULT_LIMIT
): Required<Pick<PageParams, 'offset' | 'limit'>> & { maxBytes?: number } {
  const offset = toInt(args.offset, 0);
  const limit = Math.min(toInt(args.limit, defaultLimit) || defaultLimit, MAX_LIMIT);
  const maxBytes =
    args.maxBytes === undefined ? undefined : toInt(args.maxBytes, 0) || undefined;
  return maxBytes === undefined ? { offset, limit } : { offset, limit, maxBytes };
}

/** Slice an array into a {@link Page} envelope. */
export function paginate<T>(all: readonly T[], offset: number, limit: number): Page<T> {
  const total = all.length;
  const start = Math.min(offset, total);
  const end = Math.min(start + limit, total);
  const items = all.slice(start, end);
  const truncated = end < total;
  return {
    items,
    total,
    offset: start,
    count: items.length,
    truncated,
    nextOffset: truncated ? end : null,
  };
}

/** Result of a byte-bounded string truncation. */
export interface TruncatedText {
  text: string;
  truncated: boolean;
  /** Total byte length of the untruncated source. */
  totalBytes: number;
  /** Byte length actually returned. */
  returnedBytes: number;
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte character. Returns the original string untouched when it fits or
 * when `maxBytes` is undefined.
 */
export function truncateBytes(text: string, maxBytes?: number): TruncatedText {
  const buf = Buffer.from(text, 'utf8');
  const totalBytes = buf.length;
  if (maxBytes === undefined || totalBytes <= maxBytes) {
    return { text, truncated: false, totalBytes, returnedBytes: totalBytes };
  }
  // Step back to a UTF-8 character boundary (continuation bytes are 0b10xxxxxx).
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  const slice = buf.subarray(0, end);
  return {
    text: slice.toString('utf8'),
    truncated: true,
    totalBytes,
    returnedBytes: slice.length,
  };
}

/**
 * JSON-Schema fragment for the shared pagination inputs. Spread into a tool's
 * `inputSchema.properties` so every reading tool documents the same contract.
 */
export const PAGE_INPUT_SCHEMA = {
  offset: {
    type: 'integer',
    minimum: 0,
    description: '0-based index of the first item to return (default 0).',
  },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_LIMIT,
    description: `Maximum number of items to return (default ${DEFAULT_LIMIT}).`,
  },
  maxBytes: {
    type: 'integer',
    minimum: 1,
    description: 'Cap the UTF-8 byte size of large string output.',
  },
} as const;
