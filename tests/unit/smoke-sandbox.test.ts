import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Routing-only protocol fixtures: these tests DO NOT prove container isolation.
const observed = vi.hoisted(() => ({
  config: null as null | { adapters: { serena: { sandbox: { mode: string } } } },
  project: '',
  launches: 0,
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(options: { args: string[]; cwd: string }) {
      observed.launches += 1;
      observed.project = options.cwd;
      const configPath = options.args[options.args.indexOf('--config') + 1];
      observed.config = JSON.parse(readFileSync(configPath, 'utf8'));
    }
    async close() {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async close() {}
    async listTools() { return { tools: [{ name: 'serena__inspect_boundary' }] }; }
    async callTool() {
      return { content: [{ type: 'text', text: JSON.stringify({
        allowedEnv: 'visible-inside-container', undeclaredSecretVisible: false, cwd: '/plugin',
      }) }] };
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  observed.config = null;
  observed.project = '';
  observed.launches = 0;
  vi.stubEnv('FOLDERFORGE_SANDBOX_RUNTIME', undefined);
  vi.stubEnv('FOLDERFORGE_SANDBOX_IMAGE', `fixture@sha256:${'a'.repeat(64)}`);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('smoke-exit'); });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('sandbox smoke runtime selection (R18, routing only)', () => {
  it.each([
    [undefined, 'docker'], ['docker', 'docker'], ['podman', 'podman'],
  ])('maps selection %s to both adapter config and success evidence %s', async (selection, expected) => {
    vi.stubEnv('FOLDERFORGE_SANDBOX_RUNTIME', selection);
    await import('../../scripts/smoke-sandbox.mjs');
    expect(observed.launches).toBe(1);
    expect(observed.config?.adapters.serena.sandbox.mode).toBe(expected);
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({ ok: true, runtime: expected });
    expect(existsSync(observed.project)).toBe(false);
  });

  it.each(['process', 'invalid-engine', ''])('rejects unsupported selection %s before launch', async (selection) => {
    vi.stubEnv('FOLDERFORGE_SANDBOX_RUNTIME', selection);
    await expect(import('../../scripts/smoke-sandbox.mjs')).rejects.toThrow('smoke-exit');
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('FOLDERFORGE_SANDBOX_RUNTIME must be docker or podman'));
    expect(observed.launches).toBe(0);
    expect(observed.project).toBe('');
  });

  it.each(['docker', 'podman'])('names %s in missing-image prerequisite guidance', async (runtime) => {
    vi.stubEnv('FOLDERFORGE_SANDBOX_RUNTIME', runtime);
    vi.stubEnv('FOLDERFORGE_SANDBOX_IMAGE', 'mutable:tag');
    await expect(import('../../scripts/smoke-sandbox.mjs')).rejects.toThrow('smoke-exit');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`${runtime} pull <image>:<tag>`));
    expect(observed.launches).toBe(0);
  });
});
