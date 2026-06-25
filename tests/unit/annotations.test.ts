import { describe, it, expect } from 'vitest';
import { deriveAnnotations, defineTool } from '../../src/tools/registry.js';

/**
 * MCP metadata: tool annotations + outputSchema plumbing (roadmap Q1).
 *
 * Annotations are derived deterministically from the frozen `mutates` / `risk`
 * contract by `deriveAnnotations`, and `defineTool` attaches them (plus any
 * declared outputSchema) to every tool. These tests pin that mapping so the
 * hints stay truthful and in lock-step with the schema lock.
 */
describe('tool annotation derivation', () => {
  it('marks a read-only tool readOnly + idempotent, never destructive', () => {
    const a = deriveAnnotations('file_read', false, 'LOW');
    expect(a.readOnlyHint).toBe(true);
    expect(a.idempotentHint).toBe(true);
    expect(a.destructiveHint).toBe(false);
    expect(a.openWorldHint).toBe(false);
  });

  it('marks a low/medium-risk mutating tool non-destructive', () => {
    const a = deriveAnnotations('file_write', true, 'MEDIUM');
    expect(a.readOnlyHint).toBe(false);
    expect(a.idempotentHint).toBe(false);
    expect(a.destructiveHint).toBe(false);
  });

  it('marks a HIGH-risk mutating tool destructive', () => {
    const a = deriveAnnotations('git_reset_hard', true, 'HIGH');
    expect(a.readOnlyHint).toBe(false);
    expect(a.destructiveHint).toBe(true);
  });

  it('marks a CRITICAL-risk mutating tool destructive', () => {
    const a = deriveAnnotations('shell_exec', true, 'CRITICAL');
    expect(a.destructiveHint).toBe(true);
  });

  it('never marks a read-only tool destructive even at HIGH risk', () => {
    const a = deriveAnnotations('some_reader', false, 'HIGH');
    expect(a.destructiveHint).toBe(false);
    expect(a.readOnlyHint).toBe(true);
  });

  it('derives a human-friendly title from the snake_case name', () => {
    expect(deriveAnnotations('git_status', false, 'LOW').title).toBe('Git Status');
    expect(deriveAnnotations('db_query_readonly', false, 'LOW').title).toBe(
      'Db Query Readonly'
    );
  });

  it('honours per-tool overrides (e.g. openWorldHint for web tools)', () => {
    const a = deriveAnnotations('web_fetch', false, 'LOW', { openWorldHint: true });
    expect(a.openWorldHint).toBe(true);
    expect(a.readOnlyHint).toBe(true);
  });
});

describe('defineTool metadata plumbing', () => {
  it('attaches derived annotations to every tool', () => {
    const tool = defineTool({
      name: 'file_read',
      description: 'read a file',
      group: 'file',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ ok: true }),
    });
    expect(tool.annotations).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.title).toBe('File Read');
  });

  it('carries a declared outputSchema through', () => {
    const schema = { type: 'object', properties: { rows: { type: 'array' } } };
    const tool = defineTool({
      name: 'db_query_readonly',
      description: 'run a read-only query',
      group: 'db',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: schema,
      handler: async () => ({ ok: true, data: { rows: [] } }),
    });
    expect(tool.outputSchema).toBe(schema);
  });

  it('leaves outputSchema undefined when none is declared', () => {
    const tool = defineTool({
      name: 'file_read',
      description: 'read a file',
      group: 'file',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ ok: true }),
    });
    expect(tool.outputSchema).toBeUndefined();
  });

  it('lets a tool override openWorldHint via annotations', () => {
    const tool = defineTool({
      name: 'browser_snapshot',
      description: 'snapshot the page',
      group: 'browser',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      annotations: { openWorldHint: true },
      handler: async () => ({ ok: true }),
    });
    expect(tool.annotations?.openWorldHint).toBe(true);
  });
});
