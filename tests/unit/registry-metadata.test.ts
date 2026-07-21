import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import { defineTool } from '../../src/tools/registry.js';
import { TS_FIXTURE } from '../integration/fixtures.js';

/**
 * Live-registry checks for the MCP metadata layer (roadmap Q1).
 *
 * Every native tool must carry derived annotations, and the high-value tools
 * called out in the roadmap must advertise a structured `outputSchema`.
 */
function liveRegistry() {
  const config = loadConfig({ projectRoot: TS_FIXTURE });
  const container = new Container(config);
  return buildRegistry(container);
}

describe('registry MCP metadata', () => {
  const registry = liveRegistry();
  const tools = registry.listAll().filter((t) => !t.name.includes('__'));

  it('gives every native tool a set of derived annotations', () => {
    for (const t of tools) {
      expect(t.annotations, `${t.name} missing annotations`).toBeDefined();
      expect(typeof t.annotations?.title, `${t.name}.title`).toBe('string');
      expect(t.annotations?.readOnlyHint, `${t.name}.readOnlyHint`).toBe(!t.mutates);
    }
  });

  it('never marks a read-only tool destructive', () => {
    for (const t of tools) {
      if (!t.mutates) {
        expect(t.annotations?.destructiveHint, `${t.name}`).toBe(false);
      }
    }
  });

  it('advertises outputSchema on the high-value read tools', () => {
    for (const name of ['run_test', 'git_status', 'db_query_readonly']) {
      const tool = registry.get(name);
      expect(tool, `missing tool ${name}`).toBeDefined();
      expect(tool?.outputSchema, `${name} should declare an outputSchema`).toBeDefined();
      expect(
        (tool?.outputSchema as Record<string, unknown>).type,
        `${name}.outputSchema.type`
      ).toBe('object');
    }
  });

  it('keeps outputSchema optional for tools that do not declare one', () => {
    const fileRead = registry.get('file_read');
    expect(fileRead).toBeDefined();
    expect(fileRead?.outputSchema).toBeUndefined();
  });

  it('emits one change only when the agent-visible catalog actually changes', () => {
    const dynamicRegistry = liveRegistry();
    let changes = 0;
    const dispose = dynamicRegistry.onListChanged(() => {
      changes += 1;
    });
    const dynamicTool = defineTool({
      name: 'dynamic_probe',
      description: 'Dynamic probe v1',
      group: 'test',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ ok: true }),
    });

    dynamicRegistry.registerAll([dynamicTool]);
    expect(changes).toBe(1);

    dynamicRegistry.register(dynamicTool);
    expect(changes).toBe(1);

    dynamicRegistry.register({ ...dynamicTool, description: 'Dynamic probe v2' });
    expect(changes).toBe(2);

    dynamicRegistry.setActive(dynamicRegistry.listAgentActive().map((tool) => tool.name));
    expect(changes).toBe(2);

    dynamicRegistry.unregisterWhere((tool) => tool.name === 'dynamic_probe');
    expect(changes).toBe(3);
    dispose();
  });
});
