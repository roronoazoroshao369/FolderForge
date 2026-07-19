import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const OS = new Set(['ubuntu', 'macos', 'windows']);
const ATTEMPT = new Set(['clean-install', 'upgrade']);
const SEVERITY = new Set(['none', 'low', 'medium', 'high', 'critical']);
const STATUS = new Set(['open', 'resolved']);

export function betaSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function redactBetaText(text) {
  return String(text)
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))\s*[=:]\s*[^\s"']+/g, '$1=[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
}

function nonEmpty(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value)) throw new Error(`${label} must be a non-empty string up to ${max} characters.`);
  return value.trim();
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`);
  return value;
}

function metric(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

export function normalizeBetaEvidence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Beta evidence must be an object.');
  if (raw.schemaVersion !== 1) throw new Error('Beta evidence schemaVersion must be 1.');
  const installationId = nonEmpty(raw.installationId, 'installationId', 256);
  if (!OS.has(raw.os)) throw new Error('os must be ubuntu, macos, or windows.');
  if (!ATTEMPT.has(raw.attemptType)) throw new Error('attemptType must be clean-install or upgrade.');
  const normalized = {
    schemaVersion: 1,
    installationHash: betaSha256(installationId),
    version: nonEmpty(raw.version, 'version', 64),
    commit: nonEmpty(raw.commit, 'commit', 64),
    os: raw.os,
    nodeVersion: nonEmpty(raw.nodeVersion, 'nodeVersion', 64),
    client: nonEmpty(raw.client, 'client', 128),
    attemptType: raw.attemptType,
    success: bool(raw.success, 'success'),
    finalCohort: bool(raw.finalCohort, 'finalCohort'),
    receivedAt: new Date().toISOString(),
  };
  if (normalized.commit.length < 7) throw new Error('commit must contain at least 7 characters.');
  if (raw.externalPlugin !== undefined) {
    if (!raw.externalPlugin || typeof raw.externalPlugin !== 'object' || Array.isArray(raw.externalPlugin)) throw new Error('externalPlugin must be an object.');
    normalized.externalPlugin = {
      packageHash: betaSha256(nonEmpty(raw.externalPlugin.packageId, 'externalPlugin.packageId', 256)),
      validated: bool(raw.externalPlugin.validated, 'externalPlugin.validated'),
      sandboxReviewed: bool(raw.externalPlugin.sandboxReviewed, 'externalPlugin.sandboxReviewed'),
    };
  }
  if (raw.issue !== undefined) {
    if (!raw.issue || typeof raw.issue !== 'object' || Array.isArray(raw.issue)) throw new Error('issue must be an object.');
    if (!SEVERITY.has(raw.issue.severity) || !STATUS.has(raw.issue.status)) throw new Error('issue severity/status is invalid.');
    normalized.issue = {
      severity: raw.issue.severity,
      status: raw.issue.status,
      dataLoss: bool(raw.issue.dataLoss, 'issue.dataLoss'),
      releaseBlocking: bool(raw.issue.releaseBlocking, 'issue.releaseBlocking'),
      regressionTestAdded: bool(raw.issue.regressionTestAdded, 'issue.regressionTestAdded'),
    };
  }
  if (raw.docsExercisedByExternal !== undefined) normalized.docsExercisedByExternal = bool(raw.docsExercisedByExternal, 'docsExercisedByExternal');
  if (raw.metrics !== undefined) {
    if (!raw.metrics || typeof raw.metrics !== 'object' || Array.isArray(raw.metrics)) throw new Error('metrics must be an object.');
    normalized.metrics = {};
    for (const key of ['timeToFirstToolMs', 'approvalInterruptions', 'childRecoveryMs']) {
      if (raw.metrics[key] !== undefined) normalized.metrics[key] = metric(raw.metrics[key], `metrics.${key}`);
    }
  }
  if (raw.notes !== undefined) normalized.notes = redactBetaText(nonEmpty(raw.notes, 'notes', 2000));
  return normalized;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function evidenceRoot(project) {
  return join(resolve(project), '.folderforge', 'beta', 'evidence');
}

export function ingestBetaEvidence(project, raw) {
  const normalized = normalizeBetaEvidence(raw);
  const identity = betaSha256(canonical({ ...normalized, receivedAt: undefined }));
  const root = evidenceRoot(project);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${identity}.json`);
  if (existsSync(path)) return { duplicate: true, id: identity, path, evidence: JSON.parse(readFileSync(path, 'utf8')) };
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(normalized, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
  return { duplicate: false, id: identity, path, evidence: normalized };
}

export function loadBetaEvidence(project) {
  const root = evidenceRoot(project);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort().map((name) => JSON.parse(readFileSync(join(root, name), 'utf8')));
}

export function betaReport(project) {
  const evidence = loadBetaEvidence(project);
  const completed = new Set(evidence.filter((item) => item.success).map((item) => item.installationHash));
  const os = Object.fromEntries([...OS].map((name) => [name, new Set(evidence.filter((item) => item.success && item.os === name).map((item) => item.installationHash)).size]));
  const clients = new Set(evidence.filter((item) => item.success).map((item) => item.client));
  const plugins = new Set(evidence.filter((item) => item.externalPlugin?.validated && item.externalPlugin?.sandboxReviewed).map((item) => item.externalPlugin.packageHash));
  const unresolvedSevere = evidence.filter((item) => item.issue && item.issue.status === 'open' && (['high', 'critical'].includes(item.issue.severity) || item.issue.dataLoss));
  const blockersWithoutRegression = evidence.filter((item) => item.issue?.releaseBlocking && !item.issue.regressionTestAdded);
  const final = evidence.filter((item) => item.finalCohort);
  const finalSuccessRate = final.length ? final.filter((item) => item.success).length / final.length : 0;
  const externalDocs = evidence.some((item) => item.docsExercisedByExternal === true);
  const gates = {
    installations: completed.size >= 30,
    osCoverage: os.ubuntu > 0 && os.macos > 0 && os.windows > 0,
    clients: clients.size >= 3,
    externalPlugins: plugins.size >= 5,
    noSevereOpenIssues: unresolvedSevere.length === 0,
    finalCohortSuccess: final.length > 0 && finalSuccessRate >= 0.95,
    regressionCoverage: blockersWithoutRegression.length === 0,
    externalDocsExercise: externalDocs,
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    evidenceRecords: evidence.length,
    completedInstallations: completed.size,
    os,
    independentClients: clients.size,
    externalPluginsValidated: plugins.size,
    unresolvedSevereIssues: unresolvedSevere.length,
    releaseBlockersWithoutRegression: blockersWithoutRegression.length,
    finalCohort: { attempts: final.length, successRate: finalSuccessRate },
    gates,
    graduated: Object.values(gates).every(Boolean),
  };
}

function parse(argv) {
  const command = argv[0];
  let project = '.';
  let file;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--project') project = argv[++i];
    else if (argv[i] === '--file') file = argv[++i];
    else throw new Error(`Unknown beta option: ${argv[i]}`);
  }
  return { command, project, file };
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.command === 'ingest') {
    if (!args.file) throw new Error('beta ingest requires --file.');
    console.log(JSON.stringify(ingestBetaEvidence(args.project, JSON.parse(readFileSync(resolve(args.file), 'utf8'))), null, 2));
    return;
  }
  if (args.command === 'report') {
    console.log(JSON.stringify(betaReport(args.project), null, 2));
    return;
  }
  throw new Error('Usage: node scripts/beta-evidence.mjs ingest --file evidence.json [--project DIR] | report [--project DIR]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exit(1); });
}
