import { checkArchitecture } from './architecture-lib.mjs';

const report = checkArchitecture(process.cwd());
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `Architecture check: ${report.ok ? 'PASS' : 'FAIL'}; files=${report.files}; runtimeEdges=${report.runtimeEdges}; cycles=${report.cycles.length}; violations=${report.violations.length}`,
  );
  for (const cycle of report.cycles) {
    console.error(`runtime cycle: ${cycle.join(' -> ')}`);
  }
  for (const violation of report.violations) {
    console.error(`${violation.code}: ${violation.from} -> ${violation.to}`);
  }
}
if (!report.ok) process.exitCode = 1;
