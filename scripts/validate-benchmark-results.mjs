import { resolve } from 'node:path';
import { loadResult } from './benchmark-lib.mjs';

const files = process.argv.slice(2).map((file) => resolve(file));
if (!files.length) {
  console.error('Usage: node scripts/validate-benchmark-results.mjs <result.json> [...]');
  process.exit(2);
}

for (const file of files) {
  const { result } = loadResult(file);
  console.log(`${file}: valid (${result.runs.length} runs; ${result.system.name} ${result.system.version})`);
}
