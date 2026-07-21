import { resolve } from 'node:path';
import { loadResult } from './benchmark-lib.mjs';

const args = process.argv.slice(2);
const verifyEvidence = args.includes('--verify-evidence');
const files = args.filter((arg) => arg !== '--verify-evidence').map((file) => resolve(file));
if (!files.length) {
  console.error('Usage: node scripts/validate-benchmark-results.mjs [--verify-evidence] <result.json> [...]');
  process.exit(2);
}

for (const file of files) {
  const { result } = loadResult(file, { verifyEvidence });
  const evidence = verifyEvidence ? '; raw evidence verified' : '';
  console.log(`${file}: valid (${result.runs.length} runs; ${result.system.name} ${result.system.version}${evidence})`);
}
