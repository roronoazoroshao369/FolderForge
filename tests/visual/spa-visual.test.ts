/**
 * Visual regression suite for the Mission Control SPA (proposal 018, debt
 * #21/#24): boots the REAL dashboard harness (fixture data, no auth) serving
 * the BUILT SPA at /app/, drives headless Chromium via playwright-core
 * (cached binary, offline), and pixel-diffs every screen against committed
 * baselines in tests/visual/baselines/.
 *
 * Regenerate baselines intentionally (never as a reflex):
 *   FF_VISUAL_UPDATE=1 npx vitest run tests/visual
 * The suite self-skips when no Chromium binary is available (CI hosts
 * without the ms-playwright cache stay green — documented limitation).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { buildRegistry } from '../../src/tools/index.js';
import { diffPngs, MAX_DIFF_RATIO } from './lib/pixel-diff.js';

const UPDATE = process.env.FF_VISUAL_UPDATE === '1';
const BASELINES = fileURLToPath(new URL('./baselines', import.meta.url));
const DESKTOP = { width: 1280, height: 900 } as const;
const MOBILE = { width: 390, height: 844 } as const;

const ROUTES: ReadonlyArray<{ name: string; path: string }> = [
  { name: 'overview', path: '/' },
  { name: 'fleet', path: '/fleet' },
  { name: 'tools', path: '/tools' },
  { name: 'tunnels', path: '/tunnels' },
  { name: 'workspaces', path: '/workspaces' },
  { name: 'plugins', path: '/plugins' },
  { name: 'approvals', path: '/approvals' },
  { name: 'audit', path: '/audit' },
  { name: 'settings', path: '/settings' },
];
/** Responsive spot-checks (the two screens audited at 390px in #17). */
const MOBILE_ROUTES: ReadonlySet<string> = new Set(['overview', 'fleet']);

/** playwright-core's registry resolves the cached chromium build offline;
 * fall back to the newest cached chromium-* (e.g. when the packaged
 * playwright version and the cached revision drift apart).
 *
 * tests/setup.ts sandboxes $HOME to a temp dir (probe evidence 2026-09-09),
 * so playwright-core's default cache (~/.cache/ms-playwright) points into
 * the void inside vitest. Pin the REAL user cache — resolved from the OS
 * password entry via userInfo(), not $HOME — before any registry call. */
function resolveChromiumExecutable(): string | undefined {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir, '.cache', 'ms-playwright');
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH;
  try {
    const p = chromium.executablePath();
    if (existsSync(p)) return p;
  } catch {
    // Registry lookup failed — scan the cache directly.
  }
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache)
    .filter((d) => /^chromium(?:_headless_shell)?-\d+$/.test(d))
    .sort((a, b) => Number(b.match(/\d+$/)![0]) - Number(a.match(/\d+$/)![0]));
  for (const build of builds) {
    for (const rel of [
      'chrome-linux/chrome',
      'chrome-linux64/chrome',
      'chrome-linux/headless_shell',
      'chrome-linux64/headless_shell',
    ]) {
      const p = join(cache, build, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const CHROMIUM = resolveChromiumExecutable();

interface VisualHarness {
  root: string;
  server: Server;
  baseUrl: string;
}

async function startHarness(): Promise<VisualHarness> {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-visual-'));
  const config = defaultConfig(root);
  config.rateLimit.enabled = false;
  config.policy.defaultMode = 'dev';
  const container = new Container(config);
  const registry = buildRegistry(container);
  const server = startDashboard(container, registry, { host: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { root, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

/** Navigate, stabilize, and capture a full-page screenshot. Security
 * amendment: any request off 127.0.0.1 is aborted AND fails the test — the
 * SPA must be fully self-contained (bundled icons, system fonts). */
async function shoot(context: BrowserContext, url: string): Promise<Buffer> {
  const page = await context.newPage();
  const external: string[] = [];
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
      void route.continue();
    } else {
      external.push(u.toString());
      void route.abort();
    }
  });
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    // Kill animations/transitions so pixels are stable (animate-pulse-dot,
    // animate-fade-in, hover transitions) — the #1 flake source for SPA shots.
    await page.addStyleTag({
      content: '* { animation: none !important; transition: none !important; }',
    });
    await page.waitForTimeout(300); // one beat past the first data paint
    expect(external).toEqual([]);
    return await page.screenshot({ fullPage: true });
  } finally {
    await page.close();
  }
}

function compare(name: string, viewportLabel: string, actual: Buffer): void {
  const baselinePath = join(BASELINES, `${name}.${viewportLabel}.png`);
  if (UPDATE) {
    mkdirSync(BASELINES, { recursive: true });
    writeFileSync(baselinePath, actual);
    console.log(`[visual] baseline written: ${name}.${viewportLabel}.png (${actual.length} bytes)`);
    return;
  }
  if (!existsSync(baselinePath)) {
    throw new Error(
      `Missing baseline ${name}.${viewportLabel}.png — regenerate intentionally with FF_VISUAL_UPDATE=1`,
    );
  }
  const result = diffPngs(readFileSync(baselinePath), actual);
  const pct = (result.ratio * 100).toFixed(3);
  if (!result.sameDimensions) {
    writeFileSync(`/tmp/ff-visual-${name}.${viewportLabel}.actual.png`, actual);
    throw new Error(
      `Dimension mismatch for ${name}.${viewportLabel}: baseline is ${result.width}x${result.height} ` +
        `(actual written to /tmp/ff-visual-${name}.${viewportLabel}.actual.png)`,
    );
  }
  if (result.ratio > MAX_DIFF_RATIO) {
    writeFileSync(`/tmp/ff-visual-${name}.${viewportLabel}.actual.png`, actual);
    if (result.diffPng) {
      writeFileSync(`/tmp/ff-visual-${name}.${viewportLabel}.diff.png`, result.diffPng);
    }
    throw new Error(
      `Visual regression on ${name}.${viewportLabel}: ${result.diffPixels}/${result.totalPixels} px ` +
        `(${pct}%) exceeds ${MAX_DIFF_RATIO * 100}% — artifacts: ` +
        `/tmp/ff-visual-${name}.${viewportLabel}.{actual,diff}.png`,
    );
  }
  console.log(`[visual] ${name}.${viewportLabel}: ${result.diffPixels}/${result.totalPixels} px (${pct}%)`);
}

describe.skipIf(!CHROMIUM)('Mission Control SPA visual regression (proposal 018)', () => {
  let harness: VisualHarness;
  let browser: Browser;
  let desktop: BrowserContext;
  let mobile: BrowserContext;

  beforeAll(async () => {
    harness = await startHarness();
    // Preflight: the suite reads the BUILT SPA — fail loudly if it is stale/missing.
    const probe = await fetch(`${harness.baseUrl}/app/`);
    const html = await probe.text();
    if (probe.status !== 200 || !html.includes('id="root"')) {
      throw new Error('SPA bundle not served at /app/ — run `npm run build` first.');
    }
    browser = await chromium.launch({ executablePath: CHROMIUM!, headless: true });
    desktop = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 });
    mobile = await browser.newContext({ viewport: MOBILE, deviceScaleFactor: 1, isMobile: true });
  }, 60_000);

  afterAll(async () => {
    await desktop?.close().catch(() => undefined);
    await mobile?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (harness?.server.listening) {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    }
    if (harness) rmSync(harness.root, { recursive: true, force: true });
  });

  for (const route of ROUTES) {
    it(`matches the baseline for ${route.name} (desktop)`, { timeout: 30_000 }, async () => {
      const shot = await shoot(desktop, `${harness.baseUrl}/app${route.path}`);
      compare(route.name, 'desktop', shot);
    });
    if (MOBILE_ROUTES.has(route.name)) {
      it(`matches the baseline for ${route.name} (mobile)`, { timeout: 30_000 }, async () => {
        const shot = await shoot(mobile, `${harness.baseUrl}/app${route.path}`);
        compare(route.name, 'mobile', shot);
      });
    }
  }
});
