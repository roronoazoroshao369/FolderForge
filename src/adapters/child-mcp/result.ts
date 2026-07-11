import type { ToolContentBlock, ToolResult } from '../../core/types.js';

/** A loose view of an MCP child `tools/call` result. */
type ChildCallResult = Record<string, unknown> & {
  content?: unknown[];
  isError?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Convert standards-based MCP child content into FolderForge's internal rich
 * content representation. Unknown blocks remain available in `ToolResult.data`
 * but are not advertised as renderable content.
 */
export function normalizeChildContent(content: unknown): ToolContentBlock[] {
  if (!Array.isArray(content)) return [];

  const blocks: ToolContentBlock[] = [];
  for (const item of content) {
    if (!isRecord(item) || typeof item.type !== 'string') continue;

    if (item.type === 'text' && typeof item.text === 'string') {
      blocks.push({ kind: 'text', text: item.text });
      continue;
    }

    if (
      item.type === 'image' &&
      typeof item.data === 'string' &&
      typeof item.mimeType === 'string'
    ) {
      blocks.push({ kind: 'image', data: item.data, mimeType: item.mimeType });
      continue;
    }

    if (item.type === 'resource' && isRecord(item.resource)) {
      const resource = item.resource;
      if (typeof resource.uri === 'string' && typeof resource.text === 'string') {
        blocks.push({
          kind: 'resource',
          uri: resource.uri,
          text: resource.text,
          ...(typeof resource.title === 'string' ? { title: resource.title } : {}),
          ...(typeof resource.mimeType === 'string' ? { mimeType: resource.mimeType } : {}),
        });
      }
      continue;
    }

    if (item.type === 'resource_link' && typeof item.uri === 'string') {
      blocks.push({
        kind: 'resource_link',
        uri: item.uri,
        ...(typeof item.name === 'string' ? { name: item.name } : {}),
        ...(typeof item.title === 'string' ? { title: item.title } : {}),
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
      });
    }
  }

  return blocks;
}

function childErrorText(content: ToolContentBlock[]): string | null {
  const text = content
    .filter((block): block is Extract<ToolContentBlock, { kind: 'text' }> => block.kind === 'text')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n');
  return text || null;
}

/**
 * Preserve a child MCP result as structured `data`, while promoting its renderable
 * content to the parent MCP response. A child `isError: true` becomes a genuine
 * FolderForge error so policy audit records `tool_error` instead of a false
 * success.
 */
export function childCallToToolResult(raw: unknown, label: string): ToolResult {
  const record = isRecord(raw) ? (raw as ChildCallResult) : null;
  const content = normalizeChildContent(record?.content);
  const failed = record?.isError === true;

  return {
    ok: !failed,
    data: raw,
    ...(content.length > 0 ? { content } : {}),
    ...(failed
      ? {
          error: `${label} failed: ${childErrorText(content) ?? 'child MCP returned isError=true'}`,
        }
      : {}),
  };
}
