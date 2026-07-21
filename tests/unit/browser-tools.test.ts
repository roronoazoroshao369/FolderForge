import { describe, expect, it } from 'vitest';
import { browserTools } from '../../src/tools/browser-tools.js';
import { agentTools } from '../../src/tools/agent-tools.js';
import { workflowTools } from '../../src/tools/workflow-tools.js';
import { loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry, resolveActiveTools, TASK_PRESETS } from '../../src/tools/index.js';
import { TS_FIXTURE } from '../integration/fixtures.js';

describe('browser tool surface', () => {
  const tools = browserTools();
  const agents = agentTools();
  const workflows = workflowTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  it('exposes viewport resizing for responsive UI tests', () => {
    const tool = byName.get('browser_set_viewport');
    expect(tool).toBeDefined();
    expect(tool?.risk).toBe('MEDIUM');
    expect(tool?.mutates).toBe(true);
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['width', 'height'],
      properties: {
        width: { type: 'integer', minimum: 1, maximum: 10000 },
        height: { type: 'integer', minimum: 1, maximum: 10000 },
      },
    });
  });

  it('advertises the complete Playwright screenshot inputs', () => {
    const properties = byName.get('browser_screenshot')?.inputSchema.properties as
      | Record<string, unknown>
      | undefined;
    expect(properties).toBeDefined();
    expect(Object.keys(properties ?? {})).toEqual([
      'type',
      'filename',
      'element',
      'ref',
      'fullPage',
    ]);
  });

  it('keeps every browser wrapper inside the 50-tool vibe-lite cap', () => {
    const config = loadConfig({ projectRoot: TS_FIXTURE });
    const registry = buildRegistry(new Container(config));
    const active = resolveActiveTools(registry, { preset: 'vibe-lite' });

    expect(active).not.toBeNull();
    expect(active).toHaveLength(50);
    for (const tool of [...workflows, ...agents, ...tools]) {
      expect(active, `${tool.name} missing from vibe-lite`).toContain(tool.name);
    }
    expect(active).toEqual(
      expect.arrayContaining([
        'workspace_status',
        'workspace_activate',
        'process_start',
        'process_read',
        'process_tail',
        'process_stop',
        'process_list',
      ])
    );
    expect(active).not.toContain('code_find_implementations');
    expect(active).not.toContain('code_rename_symbol');

    // Re-enable one default-disabled tool to force the cap path. The pinned
    // browser group must still survive intact while the explicit tool is kept.
    const pressured = resolveActiveTools(registry, {
      preset: 'vibe-lite',
      enabled: ['run_coverage'],
    });
    expect(pressured).toHaveLength(50);
    expect(pressured).toContain('run_coverage');
    for (const tool of [...workflows, ...agents, ...tools]) {
      expect(pressured, `${tool.name} evicted under cap pressure`).toContain(tool.name);
    }
  });

  it('routes the complete browser workflow through the run_ui task preset', () => {
    for (const tool of tools) {
      expect(TASK_PRESETS.run_ui, `${tool.name} missing from run_ui`).toContain(tool.name);
    }
    expect(TASK_PRESETS.run_ui).toEqual(
      expect.arrayContaining(['process_start', 'process_read', 'process_stop'])
    );
  });
});
