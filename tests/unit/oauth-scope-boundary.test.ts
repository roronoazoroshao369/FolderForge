import { describe, expect, it } from 'vitest';
import type { Container } from '../../src/runtime/container.js';
import { defineTool, ToolRegistry } from '../../src/tools/registry.js';

function registryWithProbe(mutates: boolean): { registry: ToolRegistry; calls: { count: number } } {
  const calls = { count: 0 };
  const registry = new ToolRegistry({} as Container);
  registry.register(
    defineTool({
      name: mutates ? 'oauth_write_probe' : 'oauth_read_probe',
      description: 'OAuth scope boundary probe',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      group: 'test',
      mutates,
      risk: 'LOW',
      handler: async () => {
        calls.count += 1;
        return { ok: true };
      },
    })
  );
  return { registry, calls };
}

describe('OAuth registry scope boundary', () => {
  it('requires the read scope before a read-only handler can execute', async () => {
    const { registry, calls } = registryWithProbe(false);
    const result = await registry.callAgent('oauth_read_probe', {}, {
      principal: {
        id: 'oauth:test',
        role: 'agent',
        authMode: 'oauth',
        scopes: [],
        readScope: 'folderforge:read',
        writeScope: 'folderforge:write',
      },
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('folderforge:read');
    expect(calls.count).toBe(0);
  });

  it('requires both read and write scopes before a mutating handler can execute', async () => {
    const { registry, calls } = registryWithProbe(true);
    const result = await registry.callAgent('oauth_write_probe', {}, {
      principal: {
        id: 'oauth:test',
        role: 'agent',
        authMode: 'oauth',
        scopes: ['folderforge:write'],
        readScope: 'folderforge:read',
        writeScope: 'folderforge:write',
      },
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('folderforge:read');
    expect(calls.count).toBe(0);
  });
});
