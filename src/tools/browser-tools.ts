import { defineTool } from './registry.js';
import type { ToolDefinition, ToolContext } from '../core/types.js';

const PW_MAP: Record<string, string> = {
  browser_open: 'browser_navigate',
  browser_snapshot: 'browser_snapshot',
  browser_click: 'browser_click',
  browser_type: 'browser_type',
  browser_console: 'browser_console_messages',
  browser_network: 'browser_network_requests',
  browser_screenshot: 'browser_take_screenshot',
  browser_close: 'browser_close',
};

function isLocalOrAllowed(url: string, ctx: ToolContext): boolean {
  try {
    const u = new URL(url);
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(u.hostname)) return true;
    // Allow file:// for local fixtures.
    if (u.protocol === 'file:') return true;
    return false;
  } catch {
    return false;
  }
}

async function routeToPlaywright(ctx: ToolContext, toolName: string, args: Record<string, unknown>) {
  if (toolName === 'browser_open' && typeof args.url === 'string') {
    if (!isLocalOrAllowed(args.url, ctx) && ctx.container.policy.getMode() !== 'danger') {
      return { ok: false, error: `External URL blocked by policy: ${args.url}. Only localhost is allowed by default.` };
    }
  }
  if (!ctx.container.adapters.isEnabled('playwright')) {
    return { ok: false, error: 'Playwright adapter is disabled. Enable adapters.playwright in config.' };
  }
  try {
    const client = await ctx.container.adapters.ensure('playwright');
    const pwTool = PW_MAP[toolName] ?? toolName;
    const result = await client.callTool(pwTool, args);
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: `Playwright call failed: ${String(err)}` };
  }
}

function bTool(name: string, description: string, mutates: boolean, props: Record<string, unknown>): ToolDefinition {
  return defineTool({
    name,
    description,
    group: 'browser',
    mutates,
    inputSchema: { type: 'object', properties: props },
    handler: (args, ctx) => routeToPlaywright(ctx, name, args),
  });
}

export function browserTools(): ToolDefinition[] {
  return [
    bTool('browser_open', 'Navigate the browser to a URL (localhost only by default).', true, {
      url: { type: 'string' },
    }),
    bTool('browser_snapshot', 'Return the accessibility tree snapshot of the page.', false, {}),
    bTool('browser_click', 'Click an element on the page.', true, { element: { type: 'string' }, ref: { type: 'string' } }),
    bTool('browser_type', 'Type text into an input.', true, {
      element: { type: 'string' },
      ref: { type: 'string' },
      text: { type: 'string' },
    }),
    bTool('browser_console', 'Read browser console messages.', false, {}),
    bTool('browser_network', 'List network requests made by the page.', false, {}),
    bTool('browser_screenshot', 'Capture a screenshot of the page.', true, {}),
    bTool('browser_close', 'Close the browser session.', true, {}),
  ];
}
