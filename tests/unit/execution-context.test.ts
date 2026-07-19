import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Container } from '../../src/core/container.js';
import { loadConfig } from '../../src/core/config.js';
import {
  projectPrincipalId,
  scopedSessionId,
  withExecutionContext,
} from '../../src/core/principal.js';
import { defineTool, ToolRegistry } from '../../src/tools/registry.js';

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-context-'));
  roots.push(root);
  mkdirSync(join(root, '.folderforge', 'policies'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('execution context', () => {
  it('derives stable project/session identities from bounded non-secret context', () => {
    const root = project();
    expect(projectPrincipalId(root)).toBe(projectPrincipalId(root));
    expect(scopedSessionId('agent:a', 'session-hint')).toBe(
      scopedSessionId('agent:a', 'session-hint'),
    );
    expect(scopedSessionId('agent:a', 'session-hint')).not.toBe(
      scopedSessionId('agent:b', 'session-hint'),
    );
    expect(withExecutionContext({ id: 'agent:a', role: 'agent' }, root, 'one')).toMatchObject({
      roles: ['agent'],
      organizationId: 'organization:local',
      teamIds: ['team:local'],
      projectId: projectPrincipalId(root),
      sessionId: scopedSessionId('agent:a', 'one'),
    });
  });

  it('enforces policy-as-code in the shared registry and correlates identity in audit', async () => {
    const root = project();
    writeFileSync(
      join(root, '.folderforge', 'policies', 'deny.yaml'),
      `
version: 1
rules:
  - id: deny-demo-for-acme
    effect: deny
    tools: [demo_write]
    principals:
      organizationIds: [org:acme]
      teamIds: [team:platform]
      projectIds: [project:alpha]
      sessionIds: [session:one]
    reason: Demo writes are blocked for this execution context
`,
    );
    const config = loadConfig({ projectRoot: root });
    config.policy.defaultMode = 'dev';
    const container = new Container(config);
    const registry = new ToolRegistry(container);
    const handler = vi.fn(async () => ({ ok: true, data: { wrote: true } }));
    registry.register(
      defineTool({
        name: 'demo_write',
        description: 'demo',
        group: 'test',
        mutates: true,
        risk: 'LOW',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
    );
    const principal = {
      id: 'agent:alice',
      role: 'agent' as const,
      roles: ['developer'],
      organizationId: 'org:acme',
      teamIds: ['team:platform'],
      projectId: 'project:alpha',
      sessionId: 'session:one',
      authMode: 'stdio' as const,
    };

    const result = await registry.callAgent('demo_write', {}, { principal });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('deny-demo-for-acme'),
    });
    expect(handler).not.toHaveBeenCalled();

    const events = container.audit.recent(10);
    const denied = events.find((event) => event.type === 'policy_deny');
    expect(denied?.detail).toMatchObject({
      requesterId: 'agent:alice',
      role: 'agent',
      roles: ['developer'],
      organizationId: 'org:acme',
      teamIds: ['team:platform'],
      projectId: 'project:alpha',
      sessionId: 'session:one',
      authMode: 'stdio',
    });
  });
});
