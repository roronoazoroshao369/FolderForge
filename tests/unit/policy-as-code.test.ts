import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/runtime/config.js';
import type { ToolPrincipal } from '../../src/core/types.js';
import { PolicyAsCode } from '../../src/policy/policy-as-code.js';
import { PolicyEngine } from '../../src/policy/policy-engine.js';

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-policy-code-'));
  roots.push(root);
  mkdirSync(join(root, '.folderforge', 'policies'), { recursive: true });
  return root;
}

function policy(root: string, body: string, name = 'security.yaml'): void {
  writeFileSync(join(root, '.folderforge', 'policies', name), body);
}

const principal: ToolPrincipal = {
  id: 'agent:alice',
  role: 'agent',
  roles: ['developer'],
  organizationId: 'org:acme',
  teamIds: ['team:platform'],
  projectId: 'project:alpha',
  sessionId: 'session:one',
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PolicyAsCode', () => {
  it('matches tool, mode, mutation, risk, role, organization, team, project, and session selectors', () => {
    const root = project();
    policy(root, `
version: 1
name: production-boundary
rules:
  - id: deny-production-write
    effect: deny
    tools: ["file_*"]
    risks: [MEDIUM]
    mutates: true
    modes: [dev]
    principals:
      roles: [developer]
      organizationIds: ["org:acme"]
      teamIds: ["team:platform"]
      projectIds: ["project:alpha"]
      sessionIds: ["session:*"]
    reason: Production writes are blocked
`);
    const rules = new PolicyAsCode(root);
    expect(
      rules.evaluate({ tool: 'file_write', risk: 'MEDIUM', mutates: true, mode: 'dev', principal }),
    ).toMatchObject({ effect: 'deny', ruleId: 'deny-production-write' });
    expect(
      rules.evaluate({
        tool: 'file_write',
        risk: 'MEDIUM',
        mutates: true,
        mode: 'dev',
        principal: { ...principal, organizationId: 'org:other' },
      }),
    ).toBeUndefined();
  });

  it('does not let wildcard selectors match missing organization, team, project, or session claims', () => {
    const root = project();
    policy(root, `
version: 1
rules:
  - id: scoped-deny
    effect: deny
    tools: ["*"]
    principals:
      organizationIds: ["*"]
      teamIds: ["*"]
      projectIds: ["*"]
      sessionIds: ["*"]
    reason: Scoped deny
`);
    const rules = new PolicyAsCode(root);
    expect(
      rules.evaluate({
        tool: 'file_read',
        risk: 'LOW',
        mutates: false,
        mode: 'dev',
        principal: { id: 'agent:no-context', role: 'agent' },
      }),
    ).toBeUndefined();
  });

  it('rejects allow rules, unknown keys, duplicate rule ids, and paths outside the project', () => {
    const allowRoot = project();
    policy(allowRoot, `
version: 1
rules:
  - id: unsafe-allow
    effect: allow
    tools: ["*"]
    reason: Never valid
`);
    expect(() => new PolicyAsCode(allowRoot)).toThrow(/allow rules are intentionally unsupported/i);

    const unknownRoot = project();
    policy(unknownRoot, `
version: 1
rules:
  - id: unknown
    effect: deny
    tools: ["*"]
    bypass: true
    reason: Invalid key
`);
    expect(() => new PolicyAsCode(unknownRoot)).toThrow(/unknown key/i);

    const duplicateRoot = project();
    policy(duplicateRoot, `
version: 1
rules:
  - id: duplicate
    effect: deny
    tools: ["a"]
    reason: First
  - id: duplicate
    effect: approval
    tools: ["b"]
    reason: Second
`);
    expect(() => new PolicyAsCode(duplicateRoot)).toThrow(/duplicate policy rule id/i);

    const traversalRoot = project();
    expect(() => new PolicyAsCode(traversalRoot, ['../outside.yaml'])).toThrow(/inside the project root/i);
  });

  it('keeps an explicit approval rule active in danger mode and never weakens baseline hard denies', () => {
    const root = project();
    policy(root, `
version: 1
rules:
  - id: review-low-write
    effect: approval
    tools: ["file_write"]
    principals:
      organizationIds: ["org:acme"]
    reason: Team review required
`);
    const config = loadConfig({ projectRoot: root });
    config.policy.defaultMode = 'danger';
    config.policy.allowCriticalInDanger = true;
    const engine = new PolicyEngine(config);

    expect(engine.evaluate('file_write', 'LOW', true, {}, principal)).toMatchObject({
      kind: 'approval',
      reason: expect.stringContaining('review-low-write'),
    });

    engine.setMode('safe');
    expect(engine.evaluate('dangerous', 'CRITICAL', false, {}, principal)).toMatchObject({
      kind: 'deny',
    });
    engine.setMode('readonly');
    expect(engine.evaluate('file_write', 'LOW', true, {}, principal)).toMatchObject({
      kind: 'deny',
      reason: expect.stringContaining('readonly'),
    });
  });
});
