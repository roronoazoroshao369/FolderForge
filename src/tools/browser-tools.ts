import { defineTool } from './registry.js';
import type { ToolContentBlock, ToolDefinition, ToolContext, ToolResult } from '../core/types.js';
import { childCallToToolResult } from '../adapters/child-mcp/result.js';
import type { BrowserEmulationInput } from '../browser/emulation-manager.js';

const PW_MAP: Record<string, string> = {
  browser_open: 'browser_navigate',
  browser_snapshot: 'browser_snapshot',
  browser_click: 'browser_click',
  browser_type: 'browser_type',
  browser_console: 'browser_console_messages',
  browser_network: 'browser_network_requests',
  browser_screenshot: 'browser_take_screenshot',
  browser_set_viewport: 'browser_resize',
  browser_close: 'browser_close',
  browser_eval: 'browser_evaluate',
};

export const A11Y_AUDIT_FUNCTION = String.raw`() => {
  const violations = [];
  const selector = (element) => {
    if (!(element instanceof Element)) return '';
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const accessibleName = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const value = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (value) return value;
    }
    const aria = element.getAttribute('aria-label')?.trim();
    if (aria) return aria;
    if (element instanceof HTMLInputElement && element.labels?.length) {
      const value = Array.from(element.labels).map((label) => label.textContent || '').join(' ').trim();
      if (value) return value;
    }
    const title = element.getAttribute('title')?.trim();
    if (title) return title;
    return (element.textContent || '').trim();
  };
  const parseRgb = (value) => {
    const match = value.match(/rgba?\((\d+(?:\.\d+)?)[, ]+(\d+(?:\.\d+)?)[, ]+(\d+(?:\.\d+)?)(?:[, /]+([\d.]+))?\)/i);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])] : null;
  };
  const luminance = (rgb) => {
    const channels = rgb.slice(0, 3).map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const background = (element) => {
    let current = element;
    while (current) {
      const color = parseRgb(getComputedStyle(current).backgroundColor);
      if (color && color[3] > 0.01) return color;
      current = current.parentElement;
    }
    return [255, 255, 255, 1];
  };
  const add = (rule, impact, message, element, actual) => violations.push({
    rule,
    impact,
    message,
    selector: selector(element),
    ...(actual === undefined ? {} : { actual }),
  });

  if (!document.documentElement.lang.trim()) {
    add('html-lang', 'serious', 'The html element must declare a language.', document.documentElement);
  }
  if (!document.title.trim()) {
    add('document-title', 'serious', 'The document must have a non-empty title.', document.head || document.documentElement);
  }

  document.querySelectorAll('img').forEach((image) => {
    if (image.getAttribute('role') === 'presentation' || image.getAttribute('aria-hidden') === 'true') return;
    if (!image.hasAttribute('alt')) add('image-alt', 'critical', 'Image is missing an alt attribute.', image);
  });

  document.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach((control) => {
    if (!visible(control) || control.getAttribute('aria-hidden') === 'true') return;
    if (!accessibleName(control)) add('form-label', 'critical', 'Form control has no accessible name.', control);
  });

  document.querySelectorAll('button, a[href], [role="button"], [role="link"]').forEach((control) => {
    if (!visible(control) || control.getAttribute('aria-hidden') === 'true') return;
    if (!accessibleName(control)) add('interactive-name', 'critical', 'Interactive element has no accessible name.', control);
  });

  const ids = new Map();
  document.querySelectorAll('[id]').forEach((element) => {
    const id = element.id;
    if (!id) return;
    const prior = ids.get(id);
    if (prior) add('duplicate-id', 'serious', 'Document contains a duplicate id.', element, id);
    else ids.set(id, element);
  });

  let previousHeading = 0;
  document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading) => {
    const level = Number(heading.tagName.slice(1));
    if (previousHeading > 0 && level > previousHeading + 1) {
      add('heading-order', 'moderate', 'Heading levels should not skip ranks.', heading, { previous: previousHeading, current: level });
    }
    previousHeading = level;
  });

  let contrastChecked = 0;
  document.querySelectorAll('body *').forEach((element) => {
    if (contrastChecked >= 500 || !visible(element)) return;
    const text = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent || '').join('').trim();
    if (!text) return;
    contrastChecked += 1;
    const style = getComputedStyle(element);
    const foreground = parseRgb(style.color);
    const bg = background(element);
    if (!foreground || foreground[3] < 0.99) return;
    const light = Math.max(luminance(foreground), luminance(bg));
    const dark = Math.min(luminance(foreground), luminance(bg));
    const ratio = (light + 0.05) / (dark + 0.05);
    const fontSize = Number.parseFloat(style.fontSize);
    const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
    const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
    const required = large ? 3 : 4.5;
    if (ratio + 0.001 < required) {
      add('color-contrast', 'serious', 'Text contrast is below the WCAG AA threshold.', element, {
        ratio: Number(ratio.toFixed(2)),
        required,
        foreground: style.color,
        background: getComputedStyle(element).backgroundColor,
      });
    }
  });

  const byImpact = violations.reduce((summary, violation) => {
    summary[violation.impact] = (summary[violation.impact] || 0) + 1;
    return summary;
  }, {});
  return JSON.stringify({
    url: location.href,
    title: document.title,
    scanned: {
      elements: document.querySelectorAll('*').length,
      contrastTextNodes: contrastChecked,
    },
    summary: { violations: violations.length, byImpact },
    violations,
  });
}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocalOrAllowed(url: string, _ctx: ToolContext): boolean {
  try {
    const parsed = new URL(url);
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(parsed.hostname)) return true;
    if (parsed.protocol === 'file:') return true;
    return false;
  } catch {
    return false;
  }
}

async function callPlaywright(
  ctx: ToolContext,
  childTool: string,
  args: Record<string, unknown>,
  label: string
): Promise<ToolResult> {
  if (!ctx.container.adapters.isEnabled('playwright')) {
    return { ok: false, error: 'Playwright adapter is disabled. Enable adapters.playwright in config.' };
  }
  try {
    const client = await ctx.container.adapters.ensure('playwright');
    const result = await client.callTool(childTool, args);
    return childCallToToolResult(result, label);
  } catch (error) {
    return { ok: false, error: `Playwright call failed: ${String(error)}` };
  }
}

function firstImage(result: ToolResult): Extract<ToolContentBlock, { kind: 'image' }> | null {
  return result.content?.find(
    (block): block is Extract<ToolContentBlock, { kind: 'image' }> => block.kind === 'image'
  ) ?? null;
}

export function persistBrowserImage(
  result: ToolResult,
  ctx: ToolContext,
  sourceTool: string,
  label?: string
): ToolResult {
  if (!result.ok) return result;
  const image = firstImage(result);
  if (!image) return result;
  try {
    const data = Buffer.from(image.data, 'base64');
    const artifact = ctx.container.artifacts.put(data, image.mimeType, {
      sourceTool,
      ...(label ? { label } : {}),
    });
    return {
      ...result,
      data: isRecord(result.data)
        ? { ...result.data, artifact }
        : { childResult: result.data, artifact },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Screenshot artifact persistence failed: ${String(error)}`,
      data: result.data,
      ...(result.content ? { content: result.content } : {}),
    };
  }
}

function stringCandidates(value: unknown, output: string[], depth = 0): void {
  if (depth > 8 || output.length > 100) return;
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringCandidates(item, output, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) stringCandidates(item, output, depth + 1);
  }
}

export function extractJsonReport(value: unknown): Record<string, unknown> | null {
  const candidates: string[] = [];
  stringCandidates(value, candidates);
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const attempts = [trimmed];
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) attempts.push(trimmed.slice(first, last + 1));
    for (const attempt of attempts) {
      try {
        let parsed: unknown = JSON.parse(attempt);
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        if (isRecord(parsed)) return parsed;
      } catch {
        // Continue through bounded candidates.
      }
    }
  }
  return null;
}

async function routeToPlaywright(
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  if (toolName === 'browser_open' && typeof args.url === 'string') {
    if (!isLocalOrAllowed(args.url, ctx) && ctx.container.policy.getMode() !== 'danger') {
      return {
        ok: false,
        error: `External URL blocked by policy: ${args.url}. Only localhost is allowed by default.`,
      };
    }
  }
  const result = await callPlaywright(ctx, PW_MAP[toolName] ?? toolName, args, toolName);
  return toolName === 'browser_screenshot'
    ? persistBrowserImage(result, ctx, toolName, typeof args.filename === 'string' ? args.filename : undefined)
    : result;
}


const FLOW_ACTIONS = new Set([
  'browser_open',
  'browser_set_viewport',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_console',
  'browser_network',
  'browser_screenshot',
  'browser_visual_compare',
  'browser_accessibility_audit',
  'browser_close',
]);

function boundedFlowResult(result: ToolResult): Record<string, unknown> {
  const content = result.content?.map((block) =>
    block.kind === 'image'
      ? { kind: 'image', mimeType: block.mimeType, bytes: Buffer.byteLength(block.data, 'base64') }
      : block
  );
  const dataText = result.data === undefined ? '' : JSON.stringify(result.data);
  return {
    ok: result.ok,
    ...(result.error ? { error: result.error.slice(0, 4000) } : {}),
    ...(dataText.length <= 100_000
      ? { data: result.data }
      : { data: { truncated: true, bytes: Buffer.byteLength(dataText), preview: dataText.slice(0, 20_000) } }),
    ...(content ? { content } : {}),
  };
}

async function runBrowserFlow(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const steps = args.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 50) {
    return { ok: false, error: 'browser_flow_run.steps must contain 1-50 steps.' };
  }
  const evidence: Array<Record<string, unknown>> = [];
  const startedAt = Date.now();
  for (let index = 0; index < steps.length; index += 1) {
    if (ctx.control?.signal?.aborted) return { ok: false, error: 'Browser flow cancelled.', data: { evidence } };
    const raw = steps[index];
    if (!isRecord(raw)) return { ok: false, error: `Browser flow step ${index + 1} must be an object.`, data: { evidence } };
    const action = String(raw.action ?? '');
    if (action === 'wait') {
      const ms = Number(raw.ms ?? 0);
      if (!Number.isSafeInteger(ms) || ms < 0 || ms > 30_000) {
        return { ok: false, error: `Browser flow wait step ${index + 1} must be 0-30000ms.`, data: { evidence } };
      }
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, ms);
        timer.unref();
        ctx.control?.signal?.addEventListener('abort', () => { clearTimeout(timer); resolveWait(); }, { once: true });
      });
      const item = { index, name: raw.name ?? `wait-${index + 1}`, action, ok: !ctx.control?.signal?.aborted, durationMs: ms };
      evidence.push(item);
      ctx.container.audit.record({ type: 'process_event', tool: 'browser_flow_run:wait', ok: item.ok, durationMs: ms, summary: `step=${index + 1} wait=${ms}ms` });
      if (!item.ok) return { ok: false, error: 'Browser flow cancelled.', data: { evidence } };
      continue;
    }
    if (!FLOW_ACTIONS.has(action)) {
      return { ok: false, error: `Browser flow action is not allowed at step ${index + 1}: ${action}`, data: { evidence } };
    }
    const stepArgs = isRecord(raw.args) ? raw.args : {};
    const stepStart = Date.now();
    const result = await ctx.container.registry.callAgent(action, stepArgs, ctx.control);
    const item = {
      index,
      name: raw.name ?? `${action}-${index + 1}`,
      action,
      durationMs: Date.now() - stepStart,
      result: boundedFlowResult(result),
    };
    evidence.push(item);
    if (!result.ok && raw.continueOnError !== true) {
      return {
        ok: false,
        error: `Browser flow stopped at step ${index + 1} (${action}): ${result.error ?? 'unknown error'}`,
        data: { completedSteps: index + 1, totalSteps: steps.length, durationMs: Date.now() - startedAt, evidence },
      };
    }
  }
  return {
    ok: true,
    data: { completedSteps: steps.length, totalSteps: steps.length, durationMs: Date.now() - startedAt, evidence },
  };
}

function bTool(
  name: string,
  description: string,
  mutates: boolean,
  props: Record<string, unknown>,
  required: string[] = []
): ToolDefinition {
  return defineTool({
    name,
    description,
    group: 'browser',
    mutates,
    inputSchema: { type: 'object', properties: props, ...(required.length ? { required } : {}) },
    handler: (args, ctx) => routeToPlaywright(ctx, name, args),
  });
}

const screenshotProperties = {
  type: {
    type: 'string',
    enum: ['png', 'jpeg'],
    description: 'Image format. Defaults to png.',
  },
  filename: {
    type: 'string',
    description: 'Optional output filename used by the Playwright child server.',
  },
  element: {
    type: 'string',
    description: 'Human-readable target description. Requires ref.',
  },
  ref: {
    type: 'string',
    description: 'Exact target ref from browser_snapshot. Requires element.',
  },
  fullPage: {
    type: 'boolean',
    description: 'Capture the full scrollable page. Cannot be combined with an element target.',
  },
} as const;

export function browserTools(): ToolDefinition[] {
  return [
    bTool(
      'browser_open',
      'Navigate the browser to a URL (localhost only by default).',
      true,
      { url: { type: 'string', description: 'The URL to navigate to.' } },
      ['url']
    ),
    bTool('browser_snapshot', 'Return the accessibility tree snapshot of the page.', false, {}),
    bTool(
      'browser_click',
      'Click an element on the page. Take a browser_snapshot first to obtain the element ref.',
      true,
      {
        element: {
          type: 'string',
          description: 'Human-readable description of the element, used for logging.',
        },
        ref: {
          type: 'string',
          description: 'Exact element ref from the latest browser_snapshot.',
        },
      },
      ['element', 'ref']
    ),
    bTool(
      'browser_type',
      'Type text into an editable element. Take a browser_snapshot first to obtain the element ref.',
      true,
      {
        element: { type: 'string', description: 'Human-readable description of the field.' },
        ref: { type: 'string', description: 'Exact element ref from browser_snapshot.' },
        text: { type: 'string', description: 'Text to type into the element.' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
        slowly: { type: 'boolean', description: 'Type one character at a time.' },
      },
      ['element', 'ref', 'text']
    ),
    bTool('browser_console', 'Read browser console messages.', false, {}),
    bTool('browser_network', 'List network requests made by the page.', false, {}),
    bTool(
      'browser_screenshot',
      'Capture the viewport, page, or element; return an MCP image and persist a content-addressed artifact.',
      true,
      screenshotProperties
    ),
    bTool(
      'browser_set_viewport',
      'Resize the browser viewport for responsive UI testing.',
      true,
      {
        width: { type: 'integer', minimum: 1, maximum: 10000, description: 'Viewport width.' },
        height: { type: 'integer', minimum: 1, maximum: 10000, description: 'Viewport height.' },
      },
      ['width', 'height']
    ),
    defineTool({
      name: 'browser_visual_compare',
      description: 'Capture a PNG, store it, and compare it with a baseline artifact using deterministic pixel metrics.',
      group: 'browser',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: {
          baselineId: { type: 'string', pattern: '^art_[a-f0-9]{64}$' },
          threshold: { type: 'integer', minimum: 0, maximum: 255, default: 0 },
          storeDiff: { type: 'boolean', default: true },
          element: screenshotProperties.element,
          ref: screenshotProperties.ref,
          fullPage: screenshotProperties.fullPage,
        },
        required: ['baselineId'],
      },
      handler: async (args, ctx) => {
        const screenshotArgs: Record<string, unknown> = { type: 'png' };
        for (const key of ['element', 'ref', 'fullPage'] as const) {
          if (args[key] !== undefined) screenshotArgs[key] = args[key];
        }
        const captured = persistBrowserImage(
          await callPlaywright(ctx, 'browser_take_screenshot', screenshotArgs, 'browser_visual_compare'),
          ctx,
          'browser_visual_compare',
          `Visual comparison against ${String(args.baselineId ?? '')}`
        );
        if (!captured.ok) return captured;
        const artifact = isRecord(captured.data) && isRecord(captured.data.artifact)
          ? captured.data.artifact
          : null;
        if (!artifact || typeof artifact.id !== 'string') {
          return { ok: false, error: 'Visual comparison screenshot did not produce an artifact.', data: captured.data };
        }
        try {
          const comparison = ctx.container.artifacts.comparePng(
            String(args.baselineId ?? ''),
            artifact.id,
            {
              threshold: Number(args.threshold ?? 0),
              storeDiff: args.storeDiff !== false,
            }
          );
          return {
            ok: comparison.comparable,
            data: { artifact, comparison, childResult: captured.data },
            ...(captured.content ? { content: captured.content } : {}),
            ...(!comparison.comparable ? { error: comparison.reason ?? 'Images are not comparable.' } : {}),
          };
        } catch (error) {
          return {
            ok: false,
            error: `Visual comparison failed: ${String(error)}`,
            data: { artifact, childResult: captured.data },
            ...(captured.content ? { content: captured.content } : {}),
          };
        }
      },
    }),
    defineTool({
      name: 'browser_accessibility_audit',
      description: 'Run a bounded read-only DOM audit for names, labels, language, headings, duplicate IDs, and WCAG AA contrast.',
      group: 'browser',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, ctx) => {
        const raw = await callPlaywright(
          ctx,
          'browser_evaluate',
          { function: A11Y_AUDIT_FUNCTION },
          'browser_accessibility_audit'
        );
        if (!raw.ok) return raw;
        const report = extractJsonReport(raw.data ?? raw.content);
        if (!report) {
          return {
            ok: false,
            error: 'Accessibility audit returned no parseable structured report.',
            data: { childResult: raw.data },
          };
        }
        return { ok: true, data: report };
      },
    }),

    defineTool({
      name: 'browser_emulation_status',
      description: 'Read the active device, viewport, user-agent, and loopback network-shaping profile.',
      group: 'browser',
      mutates: false,
      risk: 'LOW',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', additionalProperties: true },
      handler: async (_args, ctx) => ({ ok: true, data: ctx.container.browserEmulation.status() }),
    }),
    defineTool({
      name: 'browser_emulate',
      description: 'Restart the Playwright child with a bounded device/viewport/user-agent profile and optional loopback offline/latency/bandwidth shaping.',
      group: 'browser',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: {
        type: 'object',
        properties: {
          preset: { type: 'string', enum: ['desktop', 'mobile', 'tablet', 'slow3g', 'fast3g', 'offline', 'reset'] },
          device: { type: 'string', maxLength: 128 },
          viewport: {
            type: 'object',
            properties: {
              width: { type: 'integer', minimum: 1, maximum: 10000 },
              height: { type: 'integer', minimum: 1, maximum: 10000 },
            },
            required: ['width', 'height'],
            additionalProperties: false,
          },
          userAgent: { type: 'string', maxLength: 1024 },
          network: {
            type: 'object',
            properties: {
              offline: { type: 'boolean' },
              latencyMs: { type: 'integer', minimum: 0, maximum: 60000 },
              downloadBytesPerSecond: { type: 'integer', minimum: 0, maximum: 1073741824 },
              uploadBytesPerSecond: { type: 'integer', minimum: 0, maximum: 1073741824 },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      outputSchema: { type: 'object', additionalProperties: true },
      handler: async (args, ctx) => {
        try { return { ok: true, data: await ctx.container.browserEmulation.apply(args as BrowserEmulationInput) }; }
        catch (error) { return { ok: false, error: `Browser emulation failed: ${String(error)}` }; }
      },
    }),
    defineTool({
      name: 'browser_flow_run',
      description: 'Run a bounded composed UI flow. Every fixed browser action re-enters the governance/audit pipeline; arbitrary JavaScript is forbidden.',
      group: 'browser',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', maxLength: 256 },
                action: {
                  type: 'string',
                  enum: [
                    'browser_open', 'browser_set_viewport', 'browser_snapshot', 'browser_click',
                    'browser_type', 'browser_console', 'browser_network', 'browser_screenshot',
                    'browser_visual_compare', 'browser_accessibility_audit', 'browser_close', 'wait',
                  ],
                },
                args: { type: 'object', additionalProperties: true },
                ms: { type: 'integer', minimum: 0, maximum: 30000 },
                continueOnError: { type: 'boolean' },
              },
              required: ['action'],
              additionalProperties: false,
            },
          },
        },
        required: ['steps'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object', additionalProperties: true },
      handler: runBrowserFlow,
    }),
    bTool('browser_close', 'Close the browser session.', true, {}),
    bTool(
      'browser_eval',
      'Evaluate a JavaScript expression in the page context. HIGH risk.',
      true,
      { function: { type: 'string', description: 'A JavaScript function to evaluate.' } },
      ['function']
    ),
  ];
}
