/**
 * content-mcp — a folder-first content studio MCP server.
 *
 * An AI agent (Claude, ChatGPT, any MCP client) connects over stdio and can:
 * manage draft posts living in a plain folder (markdown + frontmatter), then
 * publish approved content to Facebook Pages and YouTube.
 *
 * Design contract:
 * - Drafts live in CONTENT_DIR (default: ./content) as `<slug>.md` files with
 *   YAML-ish frontmatter (title, targets, status: draft|approved|published).
 * - `publish_*` tools only act on drafts marked `status: approved` — the human
 *   approves by editing one line (or by renaming status via update_draft), and
 *   when this server runs under FolderForge the publish calls are additionally
 *   approval-gated there (register publish_* as HIGH/CRITICAL in the policy).
 * - Secrets stay in the environment: FB_PAGE_ACCESS_TOKEN, YT_*. Nothing is
 *   written to disk or echoed into logs.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const CONTENT_DIR = resolve(process.env.CONTENT_DIR ?? './content');

interface DraftMeta {
  title: string;
  targets: string[];
  status: 'draft' | 'approved' | 'published';
}

function parseDraft(raw: string): { meta: DraftMeta; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  const meta: DraftMeta = { title: '', targets: [], status: 'draft' };
  if (!match) return { meta, body: raw };
  for (const line of match[1]!.split('\n')) {
    const [key, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (key?.trim() === 'title') meta.title = value;
    if (key?.trim() === 'status' && ['draft', 'approved', 'published'].includes(value)) {
      meta.status = value as DraftMeta['status'];
    }
    if (key?.trim() === 'targets') {
      meta.targets = value.replace(/[\[\]]/g, '').split(',').map((t) => t.trim()).filter(Boolean);
    }
  }
  return { meta, body: match[2] ?? '' };
}

function serializeDraft(meta: DraftMeta, body: string): string {
  return [
    '---',
    `title: ${meta.title}`,
    `targets: [${meta.targets.join(', ')}]`,
    `status: ${meta.status}`,
    '---',
    '',
    body.trim(),
    '',
  ].join('\n');
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return slug || 'untitled';
}

function draftPath(slug: string): string {
  const safe = basename(slug).replace(/\.md$/, '');
  return join(CONTENT_DIR, `${safe}.md`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Export it first (see README.md — credentials stay in the environment, never on disk).`,
    );
  }
  return value;
}

const server = new McpServer({
  name: 'content-mcp',
  version: '0.1.0',
});

// ---------------------------------------------------------------- drafts ---

server.registerTool(
  'list_drafts',
  {
    description: 'List every draft in the content folder with its title, targets, and status.',
    inputSchema: {},
  },
  async () => {
    if (!existsSync(CONTENT_DIR)) {
      return { content: [{ type: 'text', text: `Content folder is empty (${CONTENT_DIR}).` }] };
    }
    const rows = readdirSync(CONTENT_DIR)
      .filter((name) => name.endsWith('.md'))
      .map((name) => {
        const { meta } = parseDraft(readFileSync(join(CONTENT_DIR, name), 'utf8'));
        return `${name.replace(/\.md$/, '')}  [${meta.status}]  ${meta.title}  -> ${meta.targets.join(', ') || 'no targets'}`;
      });
    return { content: [{ type: 'text', text: rows.join('\n') || 'No drafts yet.' }] };
  },
);

server.registerTool(
  'read_draft',
  {
    description: 'Read one draft (frontmatter + body).',
    inputSchema: { slug: z.string().describe('Draft slug, e.g. my-first-post') },
  },
  async ({ slug }) => {
    const path = draftPath(slug);
    if (!existsSync(path)) {
      return { content: [{ type: 'text', text: `No draft named ${slug}.` }], isError: true };
    }
    return { content: [{ type: 'text', text: readFileSync(path, 'utf8') }] };
  },
);

server.registerTool(
  'create_draft',
  {
    description: 'Create a new draft post in the content folder (status starts as draft).',
    inputSchema: {
      title: z.string(),
      body: z.string().describe('Post body / caption text (markdown).'),
      targets: z.array(z.enum(['facebook', 'youtube'])).default([]),
    },
  },
  async ({ title, body, targets }) => {
    mkdirSync(CONTENT_DIR, { recursive: true });
    const slug = slugify(title);
    const path = draftPath(slug);
    if (existsSync(path)) {
      return { content: [{ type: 'text', text: `Draft ${slug} already exists; use update_draft.` }], isError: true };
    }
    writeFileSync(path, serializeDraft({ title, targets, status: 'draft' }, body), 'utf8');
    return { content: [{ type: 'text', text: `Created draft ${slug} (status: draft).` }] };
  },
);

server.registerTool(
  'update_draft',
  {
    description: 'Update a draft body/title, or change its status (draft|approved|published).',
    inputSchema: {
      slug: z.string(),
      body: z.string().optional(),
      title: z.string().optional(),
      status: z.enum(['draft', 'approved', 'published']).optional(),
    },
  },
  async ({ slug, body, title, status }) => {
    const path = draftPath(slug);
    if (!existsSync(path)) {
      return { content: [{ type: 'text', text: `No draft named ${slug}.` }], isError: true };
    }
    const { meta, body: current } = parseDraft(readFileSync(path, 'utf8'));
    writeFileSync(
      path,
      serializeDraft(
        { title: title ?? meta.title, targets: meta.targets, status: status ?? meta.status },
        body ?? current,
      ),
      'utf8',
    );
    return { content: [{ type: 'text', text: `Updated ${slug} (status: ${status ?? meta.status}).` }] };
  },
);

server.registerTool(
  'delete_draft',
  {
    description: 'Delete a draft that has never been published.',
    inputSchema: { slug: z.string() },
  },
  async ({ slug }) => {
    const path = draftPath(slug);
    if (!existsSync(path)) {
      return { content: [{ type: 'text', text: `No draft named ${slug}.` }], isError: true };
    }
    const { meta } = parseDraft(readFileSync(path, 'utf8'));
    if (meta.status === 'published') {
      return { content: [{ type: 'text', text: `${slug} is published; refusing to delete the record.` }], isError: true };
    }
    unlinkSync(path);
    return { content: [{ type: 'text', text: `Deleted ${slug}.` }] };
  },
);

// -------------------------------------------------------------- facebook ---

server.registerTool(
  'publish_facebook',
  {
    description:
      'Publish an APPROVED draft to a Facebook Page (Meta Graph API /feed). ' +
      'Needs FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN in the environment.',
    inputSchema: { slug: z.string() },
  },
  async ({ slug }) => {
    const path = draftPath(slug);
    if (!existsSync(path)) {
      return { content: [{ type: 'text', text: `No draft named ${slug}.` }], isError: true };
    }
    const { meta, body } = parseDraft(readFileSync(path, 'utf8'));
    if (meta.status !== 'approved') {
      return {
        content: [{ type: 'text', text: `${slug} is "${meta.status}" — approve it first (update_draft status=approved).` }],
        isError: true,
      };
    }
    const pageId = requireEnv('FB_PAGE_ID');
    const token = requireEnv('FB_PAGE_ACCESS_TOKEN');
    const response = await fetch(`https://graph.facebook.com/v21.0/${pageId}/feed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: `${meta.title}\n\n${body}`.trim(), access_token: token }),
    });
    const payload = (await response.json()) as { id?: string; error?: { message?: string } };
    if (!response.ok || !payload.id) {
      return {
        content: [{ type: 'text', text: `Facebook publish failed: ${payload.error?.message ?? response.statusText}` }],
        isError: true,
      };
    }
    writeFileSync(path, serializeDraft({ ...meta, status: 'published' }, body), 'utf8');
    return { content: [{ type: 'text', text: `Published to Facebook Page ${pageId}: post id ${payload.id}` }] };
  },
);

// --------------------------------------------------------------- youtube ---

async function ytAccessToken(): Promise<string> {
  const clientId = requireEnv('YT_CLIENT_ID');
  const clientSecret = requireEnv('YT_CLIENT_SECRET');
  const refreshToken = requireEnv('YT_REFRESH_TOKEN');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const payload = (await response.json()) as { access_token?: string; error_description?: string };
  if (!payload.access_token) {
    throw new Error(`YouTube token refresh failed: ${payload.error_description ?? 'unknown'}`);
  }
  return payload.access_token;
}

server.registerTool(
  'publish_youtube',
  {
    description:
      'Upload a video file as a YouTube video using an APPROVED draft for title/description ' +
      '(resumable upload). Needs YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN in the environment.',
    inputSchema: {
      slug: z.string(),
      videoPath: z.string().describe('Absolute path to the video file (mp4/mov/webm).'),
      privacy: z.enum(['private', 'unlisted', 'public']).default('private'),
    },
  },
  async ({ slug, videoPath, privacy }) => {
    const path = draftPath(slug);
    if (!existsSync(path)) {
      return { content: [{ type: 'text', text: `No draft named ${slug}.` }], isError: true };
    }
    const { meta, body } = parseDraft(readFileSync(path, 'utf8'));
    if (meta.status !== 'approved') {
      return {
        content: [{ type: 'text', text: `${slug} is "${meta.status}" — approve it first (update_draft status=approved).` }],
        isError: true,
      };
    }
    if (!existsSync(videoPath) || !statSync(videoPath).isFile()) {
      return { content: [{ type: 'text', text: `Video file not found: ${videoPath}` }], isError: true };
    }
    const token = await ytAccessToken();
    const initiate = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-length': String(statSync(videoPath).size),
        },
        body: JSON.stringify({
          snippet: { title: meta.title, description: body.trim() },
          status: { privacyStatus: privacy },
        }),
      },
    );
    const uploadUrl = initiate.headers.get('location');
    if (!initiate.ok || !uploadUrl) {
      const detail = await initiate.text();
      return { content: [{ type: 'text', text: `YouTube upload initiation failed: ${detail.slice(0, 300)}` }], isError: true };
    }
    const bytes = readFileSync(videoPath);
    const upload = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
      body: new Uint8Array(bytes),
    });
    const result = (await upload.json()) as { id?: string; error?: { message?: string } };
    if (!upload.ok || !result.id) {
      return { content: [{ type: 'text', text: `YouTube upload failed: ${result.error?.message ?? upload.statusText}` }], isError: true };
    }
    writeFileSync(path, serializeDraft({ ...meta, status: 'published' }, body), 'utf8');
    return { content: [{ type: 'text', text: `Published to YouTube: https://youtu.be/${result.id} (${privacy})` }] };
  },
);

await server.connect(new StdioServerTransport());
