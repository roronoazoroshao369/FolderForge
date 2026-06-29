import { defineTool } from './registry.js';
const PW_MAP = {
    browser_open: 'browser_navigate',
    browser_snapshot: 'browser_snapshot',
    browser_click: 'browser_click',
    browser_type: 'browser_type',
    browser_console: 'browser_console_messages',
    browser_network: 'browser_network_requests',
    browser_screenshot: 'browser_take_screenshot',
    browser_close: 'browser_close',
    browser_eval: 'browser_evaluate',
};
function isLocalOrAllowed(url, ctx) {
    try {
        const u = new URL(url);
        if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(u.hostname))
            return true;
        // Allow file:// for local fixtures.
        if (u.protocol === 'file:')
            return true;
        return false;
    }
    catch {
        return false;
    }
}
async function routeToPlaywright(ctx, toolName, args) {
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
    }
    catch (err) {
        return { ok: false, error: `Playwright call failed: ${String(err)}` };
    }
}
function bTool(name, description, mutates, props, required = []) {
    return defineTool({
        name,
        description,
        group: 'browser',
        mutates,
        inputSchema: { type: 'object', properties: props, ...(required.length ? { required } : {}) },
        handler: (args, ctx) => routeToPlaywright(ctx, name, args),
    });
}
export function browserTools() {
    return [
        bTool('browser_open', 'Navigate the browser to a URL (localhost only by default).', true, { url: { type: 'string', description: 'The URL to navigate to.' } }, ['url']),
        bTool('browser_snapshot', 'Return the accessibility tree snapshot of the page.', false, {}),
        bTool('browser_click', 'Click an element on the page. Take a browser_snapshot first to obtain the element ref.', true, {
            element: {
                type: 'string',
                description: 'Human-readable description of the element (e.g. "Submit button"), used for logging.',
            },
            ref: {
                type: 'string',
                description: 'Exact element ref from the latest browser_snapshot (e.g. "e12").',
            },
        }, ['element', 'ref']),
        bTool('browser_type', 'Type text into an editable element. Take a browser_snapshot first to obtain the element ref.', true, {
            element: {
                type: 'string',
                description: 'Human-readable description of the field (e.g. "Email textbox"), used for logging.',
            },
            ref: {
                type: 'string',
                description: 'Exact element ref from the latest browser_snapshot (e.g. "e5").',
            },
            text: { type: 'string', description: 'Text to type into the element.' },
            submit: {
                type: 'boolean',
                description: 'Press Enter after typing (submit the form). Optional.',
            },
            slowly: {
                type: 'boolean',
                description: 'Type one character at a time to trigger key handlers/autocomplete. Optional.',
            },
        }, ['element', 'ref', 'text']),
        bTool('browser_console', 'Read browser console messages.', false, {}),
        bTool('browser_network', 'List network requests made by the page.', false, {}),
        bTool('browser_screenshot', 'Capture a screenshot of the page.', true, {}),
        bTool('browser_close', 'Close the browser session.', true, {}),
        bTool('browser_eval', 'Evaluate a JavaScript expression in the page context. HIGH risk.', true, {
            function: { type: 'string', description: 'A JavaScript function body to evaluate in the page.' },
        }, ['function']),
    ];
}
