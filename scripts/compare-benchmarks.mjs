import { resolve } from 'node:path';
import { loadResult, summarize } from './benchmark-lib.mjs';

const files = process.argv.slice(2).map((file) => resolve(file));
if (files.length < 2) {
  console.error('Usage: node scripts/compare-benchmarks.mjs <result-a.json> <result-b.json> [...]');
  process.exit(2);
}

const loaded = files.map((file) => loadResult(file));
const hashes = new Set(loaded.map((item) => item.hash));
if (hashes.size !== 1) throw new Error('Benchmark results use different task manifests.');
const summaries = loaded.map((item) => summarize(item.result));
const sameHardware = new Set(summaries.map((item) => item.hardware)).size === 1;

const percent = (value) => `${(value * 100).toFixed(1)}%`;
const number = (value, digits = 1) => Number(value).toFixed(digits);
const duration = (value) => sameHardware && value !== null ? `${Math.round(value)} ms` : 'n/a*';
const tokens = (value) => value === null ? 'not reported' : number(value, 0);

console.log('| System | Runs | Success | Security pass | Median duration | Avg tool calls | Avg tokens | Avg approvals | Unintended files |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const item of summaries) {
  console.log(`| ${item.label} | ${item.runs} | ${percent(item.successRate)} | ${percent(item.securityRate)} | ${duration(item.medianDurationMs)} | ${number(item.averageToolCalls)} | ${tokens(item.averageTokens)} | ${number(item.averageApprovals)} | ${item.unintendedFiles} |`);
}
console.log('');
console.log(sameHardware
  ? '* Latency is comparable because every result declares the same OS/hardware fingerprint.'
  : '* Latency is hidden because the submitted results were produced on different OS/hardware fingerprints.');
console.log('* A valid table means the result shape and task coverage are complete; it does not independently verify self-reported evidence. Publish evidence hashes and raw audit bundles with any claim.');
