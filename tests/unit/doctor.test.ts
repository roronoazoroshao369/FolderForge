import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeDoctorCli,
  formatDoctorHuman,
  runDoctor,
  type DoctorReport,
} from '../../src/doctor/index.js';
import { PluginManager } from '../../src/plugins/plugin-manager.js';
import { ChildMcpError } from '../../src/adapters/child-mcp/client.js';

const tempRoots: string[] = [];
const passingPortProbe = async (host: string, port: number) => ({
  ok: true,
  evidence: `test probe ${host}:${port}`,
});

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-doctor-'));
  tempRoots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'doctor-fixture', version: '1.0.0', private: true }, null, 2)
  );
  return root;
}

function byId(report: DoctorReport, id: string) {
  return report.findings.find((finding) => finding.id === id);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('folderforge doctor', () => {
  it('runs read-only with stable findings and warning-only exit 0', async () => {
    const root = tempProject();
    const report = await runDoctor({
      projectRoot: root,
      now: Date.UTC(2026, 6, 11),
      portProbe: passingPortProbe,
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.findings.map((finding) => finding.id)).toEqual(
      [...report.findings.map((finding) => finding.id)].sort()
    );
    expect(byId(report, 'runtime.node')?.status).toBe('pass');
    expect(byId(report, 'config.discovery')?.status).toBe('warn');
    expect(byId(report, 'port.http')?.status).toBe('pass');
    expect(byId(report, 'playwright.chromium')).toBeDefined();
    expect(existsSync(join(root, '.folderforge'))).toBe(false);

    for (const finding of report.findings) {
      expect(finding).toEqual({
        id: expect.any(String),
        status: expect.stringMatching(/^(pass|warn|fail)$/),
        severity: expect.stringMatching(/^(info|warning|error|blocker)$/),
        summary: expect.any(String),
        evidence: expect.any(String),
        remediation: expect.any(String),
        exitCode: expect.any(Number),
      });
    }
  });

  it('returns exit 2 for an explicit missing config', async () => {
    const root = tempProject();
    const report = await runDoctor({
      projectRoot: root,
      configPath: 'missing.yaml',
      portProbe: passingPortProbe,
    });

    expect(report.exitCode).toBe(2);
    expect(byId(report, 'config.discovery')?.status).toBe('fail');
  });

  it('returns exit 1 for a corrupt discovered config', async () => {
    const root = tempProject();
    writeFileSync(join(root, 'folderforge.yaml'), 'server: [\n');

    const report = await runDoctor({ projectRoot: root, portProbe: passingPortProbe });

    expect(report.exitCode).toBe(1);
    expect(byId(report, 'config.validation')?.status).toBe('fail');
  });

  it('detects stale approval state without mutating it', async () => {
    const root = tempProject();
    mkdirSync(join(root, '.folderforge'), { recursive: true });
    const approvalPath = join(root, '.folderforge', 'approvals.jsonl');
    const stale = {
      id: 'appr_stale001',
      tool: 'git_push',
      args: {},
      risk: 'CRITICAL',
      reason: 'test',
      state: 'pending',
      createdAt: Date.UTC(2026, 6, 8),
      scope: 'once',
    };
    const body = `${JSON.stringify(stale)}\n`;
    writeFileSync(approvalPath, body);

    const report = await runDoctor({
      projectRoot: root,
      now: Date.UTC(2026, 6, 11),
      portProbe: passingPortProbe,
    });

    expect(byId(report, 'state.approvals')?.status).toBe('warn');
    expect(existsSync(approvalPath)).toBe(true);
    expect(await import('node:fs').then(({ readFileSync }) => readFileSync(approvalPath, 'utf8'))).toBe(body);
  });

  it('treats corrupt audit JSONL as an error', async () => {
    const root = tempProject();
    mkdirSync(join(root, '.folderforge', 'audit'), { recursive: true });
    writeFileSync(join(root, '.folderforge', 'audit', 'audit.jsonl'), '{not-json}\n');

    const report = await runDoctor({ projectRoot: root, portProbe: passingPortProbe });

    expect(report.exitCode).toBe(1);
    expect(byId(report, 'state.audit')?.status).toBe('fail');
  });


  it('fails when the runtime state path exists as a file', async () => {
    const root = tempProject();
    writeFileSync(join(root, '.folderforge'), 'not a directory\n');

    const report = await runDoctor({ projectRoot: root, portProbe: passingPortProbe });

    expect(report.exitCode).toBe(1);
    expect(byId(report, 'runtime.directories')).toMatchObject({
      status: 'fail',
      summary: 'Runtime state location is not writable.',
    });
    expect(byId(report, 'runtime.directories')?.evidence).toContain('not a directory');
  });

  it.skipIf(process.platform === 'win32')('reports permission denied for a read-only runtime directory', async () => {
    const root = tempProject();
    const stateRoot = join(root, '.folderforge');
    mkdirSync(stateRoot, { recursive: true });
    chmodSync(stateRoot, 0o555);
    try {
      const report = await runDoctor({ projectRoot: root, portProbe: passingPortProbe });
      expect(report.exitCode).toBe(1);
      expect(byId(report, 'runtime.directories')?.status).toBe('fail');
    } finally {
      chmodSync(stateRoot, 0o755);
    }
  });

  it('warns for missing Chromium when Playwright is disabled', async () => {
    const root = tempProject();
    writeFileSync(join(root, 'folderforge.yaml'), 'adapters:\n  playwright:\n    enabled: false\n');

    const report = await runDoctor({
      projectRoot: root,
      portProbe: passingPortProbe,
      playwrightProbe: () => ({
        packagePath: join(root, 'node_modules', 'playwright', 'index.js'),
        executablePath: join(root, 'missing-browser', 'chromium'),
        exists: false,
      }),
    });

    expect(report.exitCode).toBe(0);
    expect(byId(report, 'playwright.chromium')?.status).toBe('warn');
  });

  it('fails for missing Chromium when Playwright is enabled', async () => {
    const root = tempProject();
    writeFileSync(join(root, 'folderforge.yaml'), 'adapters:\n  playwright:\n    enabled: true\n');

    const report = await runDoctor({
      projectRoot: root,
      portProbe: passingPortProbe,
      playwrightProbe: () => ({
        packagePath: join(root, 'node_modules', 'playwright', 'index.js'),
        executablePath: join(root, 'missing-browser', 'chromium'),
        exists: false,
      }),
      adapterProbe: async () => ({
        command: process.execPath,
        args: ['/package-local/@playwright/mcp/cli.js', '--isolated'],
        cwd: root,
        source: 'package-local',
        tools: 21,
        packageName: '@playwright/mcp',
        packageVersion: '0.0.41',
      }),
    });

    expect(report.exitCode).toBe(1);
    expect(byId(report, 'playwright.chromium')?.status).toBe('fail');
  });


  it('probes every enabled child adapter and reports protocol transport evidence', async () => {
    const root = tempProject();
    writeFileSync(join(root, 'folderforge.yaml'), [
      'adapters:',
      '  serena:',
      '    enabled: true',
      `    command: ${JSON.stringify(process.execPath)}`,
      '    args: []',
      '    inheritEnv: false',
      '  playwright:',
      '    enabled: false',
      '',
    ].join('\n'));
    const probed: string[] = [];

    const report = await runDoctor({
      projectRoot: root,
      portProbe: passingPortProbe,
      playwrightProbe: () => ({
        packagePath: '/package/playwright/package.json',
        executablePath: process.execPath,
        exists: true,
      }),
      adapterProbe: async (name) => {
        probed.push(name);
        return {
          command: process.execPath,
          args: [],
          cwd: root,
          source: 'custom',
          tools: 3,
          protocolVersion: '2025-11-25',
          elapsedMs: 42,
          transport: {
            bytesReceived: 200,
            bytesSent: 100,
            messagesReceived: 2,
            messagesSent: 3,
            requestsSent: 2,
            responsesReceived: 2,
            notificationsReceived: 0,
            pendingRequests: 0,
            heartbeatsSent: 0,
          },
        };
      },
    });

    expect(probed).toEqual(['serena']);
    expect(byId(report, 'adapter.serena.handshake')).toMatchObject({
      status: 'pass',
      summary: 'serena child completed MCP initialize and tools/list.',
    });
    expect(byId(report, 'adapter.serena.handshake')?.evidence).toContain('protocol=2025-11-25');
    expect(byId(report, 'adapter.serena.handshake')?.evidence).toContain('elapsedMs=42');
    expect(byId(report, 'adapter.serena.handshake')?.evidence).toContain('"requestsSent":2');
    expect(byId(report, 'adapter.playwright.handshake')).toMatchObject({
      status: 'pass',
      summary: 'Playwright adapter handshake probe was skipped because the adapter is disabled.',
    });
  });

  it('reports the exact adapter handshake phase, stderr, and remediation', async () => {
    const root = tempProject();
    writeFileSync(join(root, 'folderforge.yaml'), `adapters:
  playwright:
    enabled: true
`);

    const diagnostic = {
      adapter: 'playwright',
      command: process.execPath,
      args: ['/package-local/@playwright/mcp/cli.js', '--isolated'],
      cwd: root,
      phase: 'initialize' as const,
      kind: 'child_exited_before_initialize' as const,
      exitCode: 1,
      signal: null,
      spawnError: '',
      stderrTail: 'browser adapter boot failed',
      timedOut: false,
      remediation: 'Run `folderforge doctor` after repairing the package.',
      occurredAt: new Date(0).toISOString(),
    };
    const report = await runDoctor({
      projectRoot: root,
      portProbe: passingPortProbe,
      playwrightProbe: () => ({
        packagePath: '/package/playwright/package.json',
        executablePath: process.execPath,
        exists: true,
      }),
      adapterProbe: async () => {
        throw new ChildMcpError('fixture failure', diagnostic);
      },
    });

    const finding = byId(report, 'adapter.playwright.handshake');
    expect(report.exitCode).toBe(1);
    expect(finding).toMatchObject({ status: 'fail', severity: 'error' });
    expect(finding?.evidence).toContain('phase=initialize');
    expect(finding?.evidence).toContain('kind=child_exited_before_initialize');
    expect(finding?.evidence).toContain('stderr=browser adapter boot failed');
    expect(finding?.remediation).toContain('repairing the package');
  });

  it('records a successful package-local initialize and tools/list probe', async () => {
    const root = tempProject();
    writeFileSync(join(root, 'folderforge.yaml'), `adapters:
  playwright:
    enabled: true
`);

    const report = await runDoctor({
      projectRoot: root,
      portProbe: passingPortProbe,
      playwrightProbe: () => ({
        packagePath: '/package/playwright/package.json',
        executablePath: process.execPath,
        exists: true,
      }),
      adapterProbe: async () => ({
        command: process.execPath,
        args: ['/package-local/@playwright/mcp/cli.js', '--isolated'],
        cwd: root,
        source: 'package-local',
        tools: 21,
        packageName: '@playwright/mcp',
        packageVersion: '0.0.41',
      }),
    });

    expect(byId(report, 'adapter.playwright.handshake')).toMatchObject({
      status: 'pass',
      summary: 'Playwright child completed MCP initialize and tools/list.',
    });
    expect(byId(report, 'adapter.playwright.handshake')?.evidence).toContain('tools=21');
  });

  it('detects tampering of an installed plugin package', async () => {
    const root = tempProject();
    const source = join(root, 'plugin-source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'server.mjs'), 'process.stdin.resume();\n');
    writeFileSync(join(source, 'folderforge.plugin.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'doctor-plugin',
      name: 'Doctor Plugin',
      version: '1.0.0',
      compatibility: { folderforge: '*' },
      runtime: { command: 'node', args: ['{pluginDir}/server.mjs'], facade: true },
      permissions: { network: false, filesystem: 'none', env: [] },
    }));
    const manager = new PluginManager(root, '2.0.0-rc.2');
    const installed = manager.install(source, false);
    writeFileSync(join(installed.installDir, 'server.mjs'), 'tampered\n');

    const report = await runDoctor({ projectRoot: root, portProbe: passingPortProbe });

    expect(report.exitCode).toBe(1);
    expect(byId(report, 'plugin.doctor-plugin')).toMatchObject({ status: 'fail' });
    expect(byId(report, 'plugin.doctor-plugin')?.evidence).toMatch(/integrity mismatch/i);
  });

  it('emits stable JSON and exit 2 for invalid CLI arguments', async () => {
    const result = await executeDoctorCli(['--json', '--unknown'], process.cwd());
    const parsed = JSON.parse(result.output) as DoctorReport;

    expect(result.exitCode).toBe(2);
    expect(parsed.exitCode).toBe(2);
    expect(parsed.findings[0]?.id).toBe('invocation.arguments');
  });

  it('formats human-readable evidence and remediation', async () => {
    const root = tempProject();
    const report = await runDoctor({ projectRoot: root, portProbe: passingPortProbe });
    const output = formatDoctorHuman(report);

    expect(output).toContain('FolderForge doctor');
    expect(output).toContain('[WARN] config.discovery');
    expect(output).toContain('Evidence:');
    expect(output).toContain('Result: exit 0');
  });
});
