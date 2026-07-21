import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry, TASK_PRESETS } from '../../src/tools/index.js';
import { FROZEN_TOOLS, FROZEN_TOOL_NAMES, frozenTool } from '../../src/tools/schema-lock.js';
import { TS_FIXTURE } from '../integration/fixtures.js';

/**
 * Schema freeze guard.
 *
 * These tests enforce the 1.0 tool-schema lock: the live registry's native tool
 * surface must match `src/tools/schema-lock.ts` exactly. They catch accidental
 * renames, removals, or risk/mutation reclassifications before release.
 *
 * If you intentionally changed the tool surface, update schema-lock.ts in the
 * same commit and treat it as an API change.
 */

function liveRegistry() {
  const config = loadConfig({ projectRoot: TS_FIXTURE });
  const container = new Container(config);
  return buildRegistry(container);
}

describe('tool schema lock (1.0 freeze)', () => {
  const registry = liveRegistry();
  // Native tools only; child-MCP adapter tools are namespaced (foo__bar) and
  // discovered dynamically, so they are excluded from the frozen surface.
  const liveTools = registry.listAll().filter((t) => !t.name.includes('__'));
  const liveNames = new Set(liveTools.map((t) => t.name));

  it('has no duplicate names in the lock', () => {
    const seen = new Set<string>();
    for (const t of FROZEN_TOOLS) {
      expect(seen.has(t.name), `duplicate in lock: ${t.name}`).toBe(false);
      seen.add(t.name);
    }
  });

  it('does not REMOVE or RENAME any frozen tool', () => {
    const missing = FROZEN_TOOLS.map((t) => t.name).filter((n) => !liveNames.has(n));
    expect(missing, `frozen tools missing from registry (rename/removal is breaking): ${missing.join(', ')}`).toEqual([]);
  });

  it('does not ADD a native tool without recording it in the lock', () => {
    const unlocked = [...liveNames].filter((n) => !FROZEN_TOOL_NAMES.has(n));
    expect(unlocked, `new native tools not in schema-lock.ts (add them there): ${unlocked.join(', ')}`).toEqual([]);
  });

  it('keeps the frozen mutates/risk contract for every tool', () => {
    for (const t of liveTools) {
      const frozen = frozenTool(t.name);
      if (!frozen) continue; // covered by the "ADD" test above
      expect(t.mutates, `${t.name}.mutates changed`).toBe(frozen.mutates);
      expect(t.risk, `${t.name}.risk changed`).toBe(frozen.risk);
    }
  });

  it('every tool exposes a JSON-Schema object inputSchema', () => {
    for (const t of liveTools) {
      expect(t.inputSchema, `${t.name} missing inputSchema`).toBeDefined();
      expect((t.inputSchema as Record<string, unknown>).type, `${t.name}.inputSchema.type`).toBe('object');
    }
  });

  it('every tool has a non-empty description', () => {
    for (const t of liveTools) {
      expect(typeof t.description, `${t.name}.description`).toBe('string');
      expect(t.description.trim().length, `${t.name}.description empty`).toBeGreaterThan(0);
    }
  });

  it('all task-preset routes reference real, frozen tools', () => {
    for (const [preset, names] of Object.entries(TASK_PRESETS)) {
      for (const n of names) {
        expect(FROZEN_TOOL_NAMES.has(n), `preset "${preset}" references unknown tool ${n}`).toBe(true);
      }
    }
  });

  it('keeps frozen admin tools internally while excluding them from the agent surface', () => {
    const all = new Set(registry.listAll().map((tool) => tool.name));
    const agent = new Set(registry.listAgentActive().map((tool) => tool.name));
    for (const name of ['approval_approve', 'approval_deny', 'policy_set_mode']) {
      expect(all.has(name), `${name} must remain in the internal schema lock`).toBe(true);
      expect(agent.has(name), `${name} must not be agent-visible`).toBe(false);
    }
  });
});
