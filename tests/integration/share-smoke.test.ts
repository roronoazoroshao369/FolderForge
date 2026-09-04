/**
 * End-to-end smoke for `folderforge share`: the real server path (loadConfig +
 * Container + buildRegistry + startHttpTransport on an ephemeral port) with
 * only output capture and the stop signal faked. Proves the printed URL and
 * temporary credential actually serve MCP over HTTP, that the credential is
 * enforced, and that teardown kills the listener.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { executeShareCli } from '../../src/share/cli.js';

const roots: string[] = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'ff-share-smoke-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Streamable HTTP answers may arrive as SSE (`data: {...}\n\n`) or plain JSON. */
async function readMcpJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
  return JSON.parse(dataLine ? dataLine.slice(5).trim() : text) as Record<string, unknown>;
}

describe('folderforge share — end-to-end smoke', () => {
  it(
    'boots a real loopback MCP server, serves the wire protocol with the temp token, and dies on teardown',
    async () => {
      const root = project();
      const written: string[] = [];
      let release: () => void = () => undefined;
      const stopped = new Promise<void>((resolveStop) => {
        release = resolveStop;
      });
      const promise = executeShareCli(['--tunnel', 'none', '--project', root], {
        hasCloudflared: () => false,
        waitForStop: () => stopped,
        write: (text) => {
          written.push(text);
        },
      });

      // Wait until the session prints its connection values.
      let out = '';
      const deadline = Date.now() + 20_000;
      while (!out.includes('MCP URL:') && Date.now() < deadline) {
        await new Promise((resolveTick) => setTimeout(resolveTick, 50));
        out = written.join('');
      }
      const urlMatch = out.match(/MCP URL: (http:\/\/127\.0\.0\.1:\d+\/mcp)/);
      const tokenMatch = out.match(/Authorization: Bearer ([A-Za-z0-9_-]{30,})/);
      expect(urlMatch, out).toBeTruthy();
      expect(tokenMatch, out).toBeTruthy();
      const mcpUrl = urlMatch![1]!;
      const token = tokenMatch![1]!;

      const headers = (withAuth: boolean, sessionId?: string): Record<string, string> => ({
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(withAuth ? { Authorization: `Bearer ${token}` } : {}),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      });

      // The temporary credential is enforced on the wire.
      const unauthorized = await fetch(mcpUrl, {
        method: 'POST',
        headers: headers(false),
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
      });
      expect(unauthorized.status).toBe(401);

      // Initialize over real HTTP.
      const init = await fetch(mcpUrl, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'share-smoke', version: '0.0.0' },
          },
        }),
      });
      expect(init.status).toBe(200);
      const initBody = await readMcpJson(init);
      const serverInfo = (initBody.result as { serverInfo?: { name?: string } }).serverInfo;
      expect(typeof serverInfo?.name).toBe('string');
      expect(serverInfo!.name!.length).toBeGreaterThan(0);
      const sessionId = init.headers.get('mcp-session-id') ?? undefined;

      await fetch(mcpUrl, {
        method: 'POST',
        headers: headers(true, sessionId),
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });

      // tools/list exposes the default preset (typed surface, includes file_read).
      const list = await fetch(mcpUrl, {
        method: 'POST',
        headers: headers(true, sessionId),
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(list.status).toBe(200);
      const listBody = await readMcpJson(list);
      const toolNames = (
        (listBody.result as { tools?: Array<{ name: string }> }).tools ?? []
      ).map((tool) => tool.name);
      expect(toolNames).toContain('file_read');
      expect(toolNames.length).toBeGreaterThan(10);

      // A governed read-only call works end to end through the temp credential.
      const call = await fetch(mcpUrl, {
        method: 'POST',
        headers: headers(true, sessionId),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'workspace_status', arguments: {} },
        }),
      });
      expect(call.status).toBe(200);
      const callBody = await readMcpJson(call);
      expect(callBody.error).toBeUndefined();

      // Teardown: the server closes and the credential dies with the process.
      release();
      const result = await promise;
      expect(result.exitCode).toBe(0);
      await expect(
        fetch(mcpUrl, { method: 'POST', headers: headers(true), body: '{}' }),
      ).rejects.toThrow();
    },
    30_000,
  );
});
