import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CRITICAL_MATCHERS = [
  /\/src\/audit\//,
  /\/src\/evidence\//,
  /\/src\/policy\/policy-engine\.ts$/,
  /\/src\/policy\/approvals\.ts$/,
  /\/src\/tools\/registry\.ts$/,
  /\/src\/server\/mcp-task-manager\.ts$/,
  /\/src\/adapters\/child-mcp\/client\.ts$/,
];

const AGGREGATE_THRESHOLDS = {
  statements: 84,
  branches: 76,
  functions: 90,
  lines: 87,
};

const FILE_THRESHOLDS = {
  statements: 75,
  branches: 50,
  functions: 70,
  lines: 75,
};

export function summarizeIstanbulFile(entry) {
  const statements = Object.values(entry.s ?? {});
  const functions = Object.values(entry.f ?? {});
  const branches = Object.values(entry.b ?? {}).flat();
  const lineHits = new Map();
  for (const [id, location] of Object.entries(entry.statementMap ?? {})) {
    const line = location.start.line;
    lineHits.set(line, (lineHits.get(line) ?? 0) + Number(entry.s?.[id] ?? 0));
  }
  const lines = [...lineHits.values()];
  return {
    statements: metric(statements),
    branches: metric(branches),
    functions: metric(functions),
    lines: metric(lines),
  };
}

function metric(hits) {
  const total = hits.length;
  const covered = hits.filter((value) => Number(value) > 0).length;
  return { covered, total, pct: total === 0 ? 100 : (covered / total) * 100 };
}

export function checkCriticalCoverage(coverage, projectRoot = process.cwd()) {
  const selected = [];
  const aggregateCounts = Object.fromEntries(
    Object.keys(AGGREGATE_THRESHOLDS).map((name) => [name, { covered: 0, total: 0 }]),
  );
  for (const [absolutePath, entry] of Object.entries(coverage)) {
    const normalized = absolutePath.replaceAll('\\', '/');
    if (!CRITICAL_MATCHERS.some((matcher) => matcher.test(normalized))) continue;
    const metrics = summarizeIstanbulFile(entry);
    const path = relative(projectRoot, absolutePath).replaceAll('\\', '/');
    selected.push({ path, metrics });
    for (const [name, value] of Object.entries(metrics)) {
      aggregateCounts[name].covered += value.covered;
      aggregateCounts[name].total += value.total;
    }
  }
  const aggregate = Object.fromEntries(
    Object.entries(aggregateCounts).map(([name, counts]) => [
      name,
      {
        ...counts,
        pct: counts.total === 0 ? 100 : (counts.covered / counts.total) * 100,
      },
    ]),
  );
  const failures = [];
  if (selected.length === 0) failures.push('No critical-path source files were found in coverage data.');
  for (const [name, threshold] of Object.entries(AGGREGATE_THRESHOLDS)) {
    if (aggregate[name].pct + Number.EPSILON < threshold) {
      failures.push(
        `critical aggregate ${name} ${aggregate[name].pct.toFixed(2)}% is below ${threshold}%`,
      );
    }
  }
  for (const file of selected) {
    for (const [name, threshold] of Object.entries(FILE_THRESHOLDS)) {
      if (file.metrics[name].pct + Number.EPSILON < threshold) {
        failures.push(
          `${file.path} ${name} ${file.metrics[name].pct.toFixed(2)}% is below ${threshold}%`,
        );
      }
    }
  }
  return {
    ok: failures.length === 0,
    files: selected.sort((a, b) => a.path.localeCompare(b.path)),
    aggregate,
    thresholds: {
      aggregate: AGGREGATE_THRESHOLDS,
      perFile: FILE_THRESHOLDS,
    },
    failures,
  };
}

function main() {
  const path = resolve(process.argv[2] ?? 'coverage/coverage-final.json');
  if (!existsSync(path)) throw new Error(`Coverage file does not exist: ${path}`);
  const report = checkCriticalCoverage(JSON.parse(readFileSync(path, 'utf8')));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
