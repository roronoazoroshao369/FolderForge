import { describe, it, expect } from 'vitest';
import { ToolRegistry, defineTool } from '../../src/tools/registry.js';
import type { ToolCallControl, ToolContext } from '../../src/core/types.js';

/**
 * Minimal fake container: the protocol-control plumbing (P4/P6/P8) does not
 * touch policy/audit/rate-limit semantics, so we stub just enough of the
 * container surface that ToolRegistry.call() reads. Everything is permissive
 * and records nothing, which keeps the test focused on `control` propagation.
 */
function fakeContainer() {
  return {
    config: {},
    projectRoot: () => '/tmp',
    audit: { record() {} },
    rateLimiter: { hit: () => ({ allowed: true }) },
    policy: {
      evaluate: () => ({ kind: 'allow' as const }),
      command: { classify: () => ({ risk: 'LOW' as const }) },
      secret: { redactValue: (value: unknown) => value },
    },
  };
}

describe('ToolRegistry protocol controls (P4/P6/P8)', () => {
  it('passes the control object through to the handler', async () => {
    const container = fakeContainer();

    const registry = new ToolRegistry(container as any);
    let seen: ToolContext['control'];
    registry.register(
      defineTool({
        name: 'spy_tool',
        description: 'records the control it received',
        group: 'test',
        mutates: false,
        risk: 'LOW',
        inputSchema: { type: 'object', properties: {} },
        handler: async (_args, ctx) => {
          seen = ctx.control;
          return { ok: true, data: { saw: Boolean(ctx.control) } };
        },
      })
    );

    const control: ToolCallControl = { signal: new AbortController().signal };
    const result = await registry.call('spy_tool', {}, control);
    expect(result.ok).toBe(true);
    expect(seen).toBe(control);
  });

  it('refuses to run when the call is already cancelled (P6)', async () => {
    const container = fakeContainer();

    const registry = new ToolRegistry(container as any);
    let handlerRan = false;
    registry.register(
      defineTool({
        name: 'never_runs',
        description: 'should not execute when pre-cancelled',
        group: 'test',
        mutates: false,
        risk: 'LOW',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          handlerRan = true;
          return { ok: true };
        },
      })
    );

    const ac = new AbortController();
    ac.abort();
    const result = await registry.call('never_runs', {}, { signal: ac.signal });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cancel/i);
    expect(handlerRan).toBe(false);
  });

  it('lets a handler emit progress through the control (P4)', async () => {
    const container = fakeContainer();

    const registry = new ToolRegistry(container as any);
    const ticks: Array<{ progress: number; message?: string }> = [];
    registry.register(
      defineTool({
        name: 'progressing_tool',
        description: 'reports progress',
        group: 'test',
        mutates: false,
        risk: 'LOW',
        inputSchema: { type: 'object', properties: {} },
        handler: async (_args, ctx) => {
          await ctx.control?.reportProgress?.(1, 3, 'step 1');
          await ctx.control?.reportProgress?.(3, 3, 'done');
          return { ok: true };
        },
      })
    );

    const control: ToolCallControl = {
      reportProgress: async (progress, _total, message) => {
        ticks.push({ progress, message });
      },
    };
    const result = await registry.call('progressing_tool', {}, control);
    expect(result.ok).toBe(true);
    expect(ticks).toEqual([
      { progress: 1, message: 'step 1' },
      { progress: 3, message: 'done' },
    ]);
  });

  it('tracks active calls without retaining argument values', async () => {
    const container = fakeContainer();
    const registry = new ToolRegistry(container as any);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });

    registry.register(
      defineTool({
        name: 'active_probe',
        description: 'waits while Mission Control inspects active metadata',
        group: 'test',
        mutates: false,
        risk: 'LOW',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          entered();
          await gate;
          return { ok: true };
        },
      }),
    );

    const call = registry.call(
      'active_probe',
      { token: 'never-retain-this-value', path: 'src/private.ts' },
      {
        principal: {
          id: 'credential:agent',
          role: 'agent',
          sessionId: 'session:active',
          oauthClientId: 'client:active',
          taskId: 'wf_active',
        },
      },
    );
    await started;

    const active = registry.listActiveCalls();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      tool: 'active_probe',
      group: 'test',
      principalId: 'credential:agent',
      sessionId: 'session:active',
      clientId: 'client:active',
      taskId: 'wf_active',
      argKeys: ['[sensitive-key]', 'path'],
    });
    expect(JSON.stringify(active)).not.toContain('never-retain-this-value');
    expect(JSON.stringify(active)).not.toContain('src/private.ts');

    release();
    expect((await call).ok).toBe(true);
    expect(registry.listActiveCalls()).toEqual([]);
  });

  it('degrades gracefully when no control is supplied', async () => {
    const container = fakeContainer();

    const registry = new ToolRegistry(container as any);
    registry.register(
      defineTool({
        name: 'optional_control',
        description: 'must work without any control object',
        group: 'test',
        mutates: false,
        risk: 'LOW',
        inputSchema: { type: 'object', properties: {} },
        handler: async (_args, ctx) => {
          // Calling the optional members must be safe when control is absent.
          await ctx.control?.reportProgress?.(1);
          return { ok: true, data: { hadControl: Boolean(ctx.control) } };
        },
      })
    );

    const result = await registry.call('optional_control', {});
    expect(result.ok).toBe(true);
    expect((result.data as { hadControl: boolean }).hadControl).toBe(false);
  });
});
