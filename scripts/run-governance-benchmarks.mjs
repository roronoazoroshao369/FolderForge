import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolRegistry, defineTool } from '../dist/tools/registry.js';
import { PolicyAsCode } from '../dist/policy/policy-as-code.js';

const RUNS = 5;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function summary(samples) {
  return {
    samplesMs: samples.map((value) => Number(value.toFixed(4))),
    minMs: Number(Math.min(...samples).toFixed(4)),
    medianMs: Number(percentile(samples, 50).toFixed(4)),
    p95Ms: Number(percentile(samples, 95).toFixed(4)),
    maxMs: Number(Math.max(...samples).toFixed(4)),
  };
}

function minimalRuntime(projectRoot) {
  return {
    config: {
      audit: {
        durability: 'best-effort',
        requireForHighRisk: true,
        requireForAuthenticatedHttp: true,
      },
    },
    projectRoot: () => projectRoot,
    audit: {
      requiresDurability: () => false,
      record: (event) => ({ ts: new Date().toISOString(), ...event }),
    },
    policy: {
      evaluate: () => ({ kind: 'allow', risk: 'LOW' }),
      command: { classify: () => ({ risk: 'LOW' }) },
      secret: { redactValue: (value) => value },
    },
    rateLimiter: { hit: () => ({ allowed: true }) },
  };
}

function buildSyntheticRegistry(projectRoot, toolCount) {
  const registry = new ToolRegistry(minimalRuntime(projectRoot));
  for (let index = 0; index < toolCount; index += 1) {
    registry.register(
      defineTool({
        name: `benchmark_tool_${String(index).padStart(4, '0')}`,
        description: 'Synthetic readonly governance benchmark tool.',
        group: 'benchmark',
        mutates: false,
        risk: 'LOW',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({ ok: true }),
      }),
    );
  }
  return registry;
}

async function benchmarkRegistry(projectRoot) {
  const build = [];
  const list = [];
  for (let run = 0; run < RUNS; run += 1) {
    let started = performance.now();
    const registry = buildSyntheticRegistry(projectRoot, 1000);
    build.push(performance.now() - started);
    started = performance.now();
    const tools = registry.listAll();
    list.push(performance.now() - started);
    if (tools.length !== 1000) throw new Error(`Expected 1000 tools, received ${tools.length}`);
  }
  return { build1000: summary(build), list1000: summary(list) };
}

function benchmarkPolicy(projectRoot) {
  const policyPath = join(projectRoot, 'policy-500.yaml');
  const rules = Array.from({ length: 500 }, (_, index) => ({
    id: `rule-${index}`,
    effect: index % 2 === 0 ? 'deny' : 'approval',
    tools: [`never_match_${index}`],
    reason: `Synthetic benchmark rule ${index}`,
  }));
  writeFileSync(policyPath, `${JSON.stringify({ version: 1, name: 'benchmark-500', rules })}\n`);
  const policy = new PolicyAsCode(projectRoot, [policyPath]);
  const batches = [];
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    for (let iteration = 0; iteration < 10_000; iteration += 1) {
      const match = policy.evaluate({
        tool: 'benchmark_target',
        risk: 'LOW',
        mutates: false,
        mode: 'safe',
        principal: { id: 'benchmark-agent', role: 'agent' },
      });
      if (match !== undefined) throw new Error('Synthetic policy unexpectedly matched.');
    }
    batches.push((performance.now() - started) / 10_000);
  }
  return summary(batches);
}

async function benchmarkStdioStartup(projectRoot, repositoryRoot) {
  const configPath = join(projectRoot, 'benchmark-config.json');
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: { defaultProject: projectRoot, allowedDirectories: [projectRoot] },
      policy: { defaultMode: 'readonly' },
      tools: { preset: 'readonly' },
      adapters: {
        serena: { enabled: false },
        playwright: { enabled: false },
        godot: { enabled: false },
      },
      server: { transport: 'stdio', dashboard: { enabled: false } },
    })}\n`,
  );
  const samples = [];
  for (let run = 0; run < RUNS; run += 1) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(repositoryRoot, 'dist', 'main.js'),
        '--stdio',
        '--config',
        configPath,
        '--project',
        projectRoot,
        '--no-dashboard',
        '--tools-preset',
        'readonly',
      ],
      cwd: projectRoot,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'),
        ),
        FOLDERFORGE_APPROVALS_PATH: join(projectRoot, `approvals-${run}.jsonl`),
      },
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'folderforge-governance-benchmark', version: '1.0.0' },
      { capabilities: {} },
    );
    const started = performance.now();
    try {
      await client.connect(transport, { timeout: 15_000 });
      await client.listTools({}, { timeout: 15_000 });
      samples.push(performance.now() - started);
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }
  return summary(samples);
}

async function main() {
  let output = resolve('benchmarks/baselines/local-governance.json');
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex !== -1) {
    const value = process.argv[outputIndex + 1];
    if (!value) throw new Error('--output requires a path');
    output = resolve(value);
  }
  const repositoryRoot = process.cwd();
  const projectRoot = mkdtempSync(join(repositoryRoot, '.folderforge-benchmark-'));
  try {
    const registry = await benchmarkRegistry(projectRoot);
    const policy500 = benchmarkPolicy(projectRoot);
    const stdioStartupAndList = await benchmarkStdioStartup(projectRoot, repositoryRoot);
    const result = {
      schemaVersion: 1,
      benchmark: 'folderforge-governance-microbenchmark-v1',
      generatedAt: new Date().toISOString(),
      runsPerWorkload: RUNS,
      system: {
        node: process.version,
        os: `${platform()}-${arch()}`,
        cpu: cpus()[0]?.model?.trim() ?? 'unknown',
        cpuCount: cpus().length,
        memoryGiB: Math.round(totalmem() / 1024 ** 3),
      },
      workloads: {
        registryBuild1000: registry.build1000,
        toolsList1000: registry.list1000,
        policyEvaluate500Rules: policy500,
        coldStdioInitializeAndToolsList: stdioStartupAndList,
      },
      targets: {
        toolsList1000P95Ms: 250,
        policyEvaluate500RulesP95Ms: 5,
        coldStdioInitializeAndToolsListP95Ms: 1500,
      },
      pass: {
        toolsList1000:
          registry.list1000.p95Ms < 250,
        policyEvaluate500Rules: policy500.p95Ms < 5,
        coldStdioInitializeAndToolsList:
          stdioStartupAndList.p95Ms < 1500,
      },
      limitations: [
        'This is a local FolderForge microbenchmark, not a competitor comparison.',
        'Synthetic tool and policy catalogs isolate runtime overhead but do not model application handler cost.',
        'Cold stdio timing includes process startup, MCP initialization, and one tools/list call on the disclosed machine.',
      ],
    };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    process.stdout.write(`${JSON.stringify({ ok: Object.values(result.pass).every(Boolean), output, ...result.pass })}\n`);
    if (!Object.values(result.pass).every(Boolean)) process.exitCode = 1;
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

await main();
