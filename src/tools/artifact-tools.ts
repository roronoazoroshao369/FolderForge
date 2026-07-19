import { defineTool } from './registry.js';
import type { ToolContentBlock, ToolDefinition } from '../core/types.js';

const ARTIFACT_ID_PATTERN = '^art_[a-f0-9]{64}$';
const MAX_INLINE_BYTES = 5 * 1024 * 1024;

export function artifactTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'artifact_put',
      description: 'Store a bounded base64 artifact in the content-addressed local artifact store.',
      group: 'artifact',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: {
          data: { type: 'string', description: 'Base64-encoded artifact bytes.' },
          mimeType: { type: 'string', description: 'IANA-style media type, e.g. image/png.' },
          label: { type: 'string', maxLength: 256 },
        },
        required: ['data', 'mimeType'],
      },
      handler: async (args, ctx) => {
        try {
          const raw = String(args.data ?? '');
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0) {
            return { ok: false, error: 'Artifact data must be canonical base64.' };
          }
          const data = Buffer.from(raw, 'base64');
          const metadata = ctx.container.artifacts.put(data, String(args.mimeType ?? ''), {
            sourceTool: 'artifact_put',
            ...(typeof args.label === 'string' ? { label: args.label } : {}),
          });
          return { ok: true, data: { artifact: metadata, stats: ctx.container.artifacts.stats() } };
        } catch (error) {
          return { ok: false, error: `Artifact store failed: ${String(error)}` };
        }
      },
    }),
    defineTool({
      name: 'artifact_list',
      description: 'List local artifact metadata without loading artifact bytes.',
      group: 'artifact',
      mutates: false,
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
      handler: async (args, ctx) => ({
        ok: true,
        data: {
          artifacts: ctx.container.artifacts.list(Number(args.limit ?? 100), Number(args.offset ?? 0)),
          stats: ctx.container.artifacts.stats(),
        },
      }),
    }),
    defineTool({
      name: 'artifact_get',
      description: 'Read artifact metadata and optionally return bounded image/text content.',
      group: 'artifact',
      mutates: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: ARTIFACT_ID_PATTERN },
          includeContent: { type: 'boolean', default: false },
        },
        required: ['id'],
      },
      handler: async (args, ctx) => {
        try {
          const id = String(args.id ?? '');
          if (args.includeContent !== true) {
            return { ok: true, data: { artifact: ctx.container.artifacts.metadata(id) } };
          }
          const { metadata, data } = ctx.container.artifacts.read(id);
          if (data.byteLength > MAX_INLINE_BYTES) {
            return {
              ok: false,
              error: `Artifact is ${data.byteLength} bytes; inline retrieval is limited to ${MAX_INLINE_BYTES}.`,
              data: { artifact: metadata },
            };
          }
          const content: ToolContentBlock[] = [];
          if (metadata.mimeType.startsWith('image/')) {
            content.push({ kind: 'image', data: data.toString('base64'), mimeType: metadata.mimeType });
          } else if (metadata.mimeType.startsWith('text/') || metadata.mimeType === 'application/json') {
            content.push({ kind: 'text', text: data.toString('utf8') });
          }
          return {
            ok: true,
            data: { artifact: metadata, inline: content.length > 0 },
            ...(content.length > 0 ? { content } : {}),
          };
        } catch (error) {
          return { ok: false, error: `Artifact read failed: ${String(error)}` };
        }
      },
    }),
    defineTool({
      name: 'artifact_compare',
      description: 'Compare two PNG artifacts pixel-by-pixel and optionally store a red diff artifact.',
      group: 'artifact',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: {
          baselineId: { type: 'string', pattern: ARTIFACT_ID_PATTERN },
          actualId: { type: 'string', pattern: ARTIFACT_ID_PATTERN },
          threshold: { type: 'integer', minimum: 0, maximum: 255, default: 0 },
          storeDiff: { type: 'boolean', default: false },
        },
        required: ['baselineId', 'actualId'],
      },
      handler: async (args, ctx) => {
        try {
          const comparison = ctx.container.artifacts.comparePng(
            String(args.baselineId ?? ''),
            String(args.actualId ?? ''),
            {
              threshold: Number(args.threshold ?? 0),
              storeDiff: args.storeDiff === true,
            }
          );
          return { ok: comparison.comparable, data: comparison, ...(!comparison.comparable ? { error: comparison.reason } : {}) };
        } catch (error) {
          return { ok: false, error: `Artifact comparison failed: ${String(error)}` };
        }
      },
    }),
    defineTool({
      name: 'artifact_delete',
      description: 'Delete one local artifact object and its metadata.',
      group: 'artifact',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', pattern: ARTIFACT_ID_PATTERN } },
        required: ['id'],
      },
      handler: async (args, ctx) => {
        try {
          return { ok: true, data: { deleted: ctx.container.artifacts.delete(String(args.id ?? '')) } };
        } catch (error) {
          return { ok: false, error: `Artifact deletion failed: ${String(error)}` };
        }
      },
    }),
  ];
}
