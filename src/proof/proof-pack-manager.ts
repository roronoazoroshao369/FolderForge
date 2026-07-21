import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { AuditEvent } from '../audit/event-types.js';
import type { ApprovalRequest } from '../policy/approvals.js';
import type { AuditVerificationReport } from '../evidence/ports.js';
import type { WorktreeIsolation } from '../isolation/worktree-manager.js';
import type { WorkflowRun } from '../workflows/workflow-manager.js';

const PACK_ID = /^proof_[a-f0-9]{24}$/;
const SAFE_FILE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const MAX_PACK_BYTES = 16 * 1024 * 1024;

export interface ProofPackFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ProofPackManifest {
  schemaVersion: 1;
  id: string;
  workflowId: string;
  ownerId: string;
  createdAt: string;
  files: ProofPackFile[];
  auditHeadHash: string | null;
  manifestSha256: string;
}

export interface ProofPackSummary {
  id: string;
  workflowId: string;
  ownerId: string;
  createdAt: string;
  manifestSha256: string;
  directory: string;
  files: ProofPackFile[];
}

export interface ProofPackCreateInput {
  run: WorkflowRun;
  approvals: ApprovalRequest[];
  auditEvents: AuditEvent[];
  auditVerification: AuditVerificationReport;
  isolation?: WorktreeIsolation;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function boundedString(value: unknown, max = 8_000): string {
  return String(value ?? '').slice(0, max);
}

function markdownEscape(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\r', '').trim();
}

function terminalState(state: WorkflowRun['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

export class ProofPackManager {
  private readonly root: string;

  constructor(
    private readonly projectRoot: string,
    private readonly redact: (text: string) => string,
  ) {
    this.root = resolve(projectRoot, '.folderforge', 'proof-packs');
  }

  create(input: ProofPackCreateInput): ProofPackSummary {
    if (!terminalState(input.run.state)) {
      throw new Error(`Proof Pack requires a terminal workflow; current=${input.run.state}.`);
    }
    if (!input.auditVerification.ok) {
      throw new Error('Proof Pack requires a valid audit chain.');
    }
    if (input.run.projectRoot !== this.projectRoot) {
      throw new Error('Proof Pack workflow belongs to a different project root.');
    }

    const createdAt = new Date().toISOString();
    const id = `proof_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const finalDir = this.packDirectory(id);
    const tempDir = `${finalDir}.tmp-${process.pid}-${randomUUID()}`;
    mkdirSync(tempDir, { recursive: false, mode: 0o700 });

    try {
      const report = this.buildReport(input, id, createdAt);
      const changes = input.run.steps
        .filter((step) => step.evidence?.diff)
        .map((step) => `# step=${step.id} tool=${step.tool}\n${step.evidence!.diff}`)
        .join('\n\n');
      const approvals = input.approvals.filter(
        (approval) =>
          approval.binding?.taskId === input.run.id ||
          input.run.steps.some((step) => step.approvalId === approval.id),
      );
      const files: Record<string, string> = {
        'report.json': `${JSON.stringify(report, null, 2)}\n`,
        'report.md': this.markdown(report),
        'changes.diff': changes ? `${changes}\n` : '',
        'approvals.json': `${JSON.stringify(approvals, null, 2)}\n`,
        'audit-events.json': `${JSON.stringify(input.auditEvents, null, 2)}\n`,
      };

      let totalBytes = 0;
      const manifestFiles: ProofPackFile[] = [];
      for (const [name, raw] of Object.entries(files)) {
        if (!SAFE_FILE.test(name)) throw new Error(`Unsafe Proof Pack filename: ${name}`);
        const redacted = this.redact(raw);
        const bytes = Buffer.byteLength(redacted);
        totalBytes += bytes;
        if (totalBytes > MAX_PACK_BYTES) throw new Error(`Proof Pack exceeds ${MAX_PACK_BYTES} bytes.`);
        writeFileSync(join(tempDir, name), redacted, { mode: 0o600 });
        manifestFiles.push({ path: name, sha256: sha256(redacted), bytes });
      }

      const unsigned = {
        schemaVersion: 1 as const,
        id,
        workflowId: input.run.id,
        ownerId: input.run.owner.principalId,
        createdAt,
        files: manifestFiles.sort((left, right) => left.path.localeCompare(right.path)),
        auditHeadHash: input.auditVerification.headHash,
      };
      const manifest: ProofPackManifest = {
        ...unsigned,
        manifestSha256: sha256(canonical(unsigned)),
      };
      writeFileSync(join(tempDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(tempDir, finalDir);
      return this.summary(manifest);
    } catch (error) {
      rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  remove(id: string): void {
    const directory = this.packDirectory(id);
    rmSync(directory, { recursive: true, force: true });
  }

  list(workflowId?: string): ProofPackSummary[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((name) => PACK_ID.test(name))
      .map((name) => {
        try {
          return this.verify(name);
        } catch {
          return null;
        }
      })
      .filter((item): item is ProofPackSummary => item !== null)
      .filter((item) => !workflowId || item.workflowId === workflowId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  verify(id: string): ProofPackSummary {
    const directory = this.packDirectory(id);
    const manifestPath = join(directory, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`Proof Pack not found: ${id}`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProofPackManifest;
    this.validateManifest(manifest, id);
    const { manifestSha256, ...unsigned } = manifest;
    if (sha256(canonical(unsigned)) !== manifestSha256) {
      throw new Error(`Proof Pack manifest integrity mismatch: ${id}`);
    }
    for (const file of manifest.files) {
      const path = join(directory, file.path);
      this.assertInside(path, directory);
      if (!existsSync(path) || !statSync(path).isFile()) {
        throw new Error(`Proof Pack file missing: ${file.path}`);
      }
      const data = readFileSync(path);
      if (data.byteLength !== file.bytes || sha256(data) !== file.sha256) {
        throw new Error(`Proof Pack file integrity mismatch: ${file.path}`);
      }
    }
    return this.summary(manifest);
  }

  private buildReport(
    input: ProofPackCreateInput,
    id: string,
    createdAt: string,
  ): Record<string, unknown> {
    const run = input.run;
    const tests = run.steps.filter((step) =>
      /(^|_)(test|lint|typecheck|build|coverage|verify|audit)($|_)/i.test(step.tool),
    );
    const runtime = run.steps.filter((step) =>
      /browser|process|game|http|server|runtime/i.test(step.tool),
    );
    return {
      schemaVersion: 1,
      proofPackId: id,
      createdAt,
      objective: run.task.objective,
      acceptanceCriteria: run.task.acceptanceCriteria,
      plan: run.definition.steps.map((step) => ({
        id: step.id,
        role: step.role,
        tool: step.tool,
        dependencies: step.dependsOn ?? [],
        description: step.description,
      })),
      contextProvenance: run.steps.map((step) => ({
        stepId: step.id,
        role: step.role,
        tool: step.tool,
        resolvedArgs: step.resolvedArgs,
        evidenceState: step.state,
      })),
      workflow: {
        id: run.id,
        definitionHash: run.definitionHash,
        state: run.state,
        owner: run.owner,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        failure: run.failure,
        steps: run.steps,
      },
      commands: run.steps.map((step) => ({
        stepId: step.id,
        tool: step.tool,
        args: step.resolvedArgs,
        attempts: step.attempts,
        state: step.state,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
      })),
      testResults: tests,
      runtimeEvidence: runtime,
      approvals: input.approvals.filter(
        (approval) =>
          approval.binding?.taskId === run.id ||
          run.steps.some((step) => step.approvalId === approval.id),
      ),
      securityEvents: input.auditEvents.filter((event) =>
        ['policy_deny', 'approval_request', 'approval_resolved', 'rate_limited', 'tool_error'].includes(
          event.type,
        ),
      ),
      audit: input.auditVerification,
      rollbackCheckpoint: input.isolation ?? null,
      knownLimitations: run.task.knownLimitations,
    };
  }

  private markdown(report: Record<string, unknown>): string {
    const workflow = report.workflow as Record<string, unknown>;
    const criteria = report.acceptanceCriteria as string[];
    const limitations = report.knownLimitations as string[];
    const plan = report.plan as Array<Record<string, unknown>>;
    return `${[
      '# FolderForge Proof Pack',
      '',
      `- Proof Pack: \`${boundedString(report.proofPackId)}\``,
      `- Workflow: \`${boundedString(workflow.id)}\``,
      `- State: **${markdownEscape(boundedString(workflow.state))}**`,
      `- Created: ${boundedString(report.createdAt)}`,
      '',
      '## Objective',
      '',
      markdownEscape(boundedString(report.objective)),
      '',
      '## Acceptance criteria',
      '',
      ...(criteria.length ? criteria.map((item) => `- ${markdownEscape(item)}`) : ['- None declared.']),
      '',
      '## Plan and results',
      '',
      '| Step | Role | Tool | Result |',
      '| --- | --- | --- | --- |',
      ...plan.map((step) => {
        const result = (workflow.steps as Array<Record<string, unknown>>).find(
          (item) => item.id === step.id,
        );
        return `| ${markdownEscape(boundedString(step.id))} | ${markdownEscape(boundedString(step.role))} | ${markdownEscape(boundedString(step.tool))} | ${markdownEscape(boundedString(result?.state))} |`;
      }),
      '',
      '## Known limitations',
      '',
      ...(limitations.length
        ? limitations.map((item) => `- ${markdownEscape(item)}`)
        : ['- None declared.']),
      '',
      '## Integrity',
      '',
      'See `manifest.json` for per-file SHA-256 hashes and the manifest digest.',
      '',
    ].join('\n')}\n`;
  }

  private validateManifest(manifest: ProofPackManifest, id: string): void {
    if (manifest.schemaVersion !== 1 || manifest.id !== id || !PACK_ID.test(manifest.id)) {
      throw new Error(`Invalid Proof Pack manifest: ${id}`);
    }
    if (!/^wf_[a-z0-9]+$/i.test(manifest.workflowId) || !manifest.ownerId) {
      throw new Error(`Invalid Proof Pack ownership: ${id}`);
    }
    if (!Number.isFinite(Date.parse(manifest.createdAt))) {
      throw new Error(`Invalid Proof Pack timestamp: ${id}`);
    }
    if (!/^[a-f0-9]{64}$/.test(manifest.manifestSha256)) {
      throw new Error(`Invalid Proof Pack manifest digest: ${id}`);
    }
    if (!Array.isArray(manifest.files) || manifest.files.length < 1) {
      throw new Error(`Proof Pack file inventory is empty: ${id}`);
    }
    const seen = new Set<string>();
    for (const file of manifest.files) {
      if (!SAFE_FILE.test(file.path) || basename(file.path) !== file.path || seen.has(file.path)) {
        throw new Error(`Unsafe or duplicate Proof Pack file: ${file.path}`);
      }
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
        throw new Error(`Invalid Proof Pack file metadata: ${file.path}`);
      }
      seen.add(file.path);
    }
  }

  private summary(manifest: ProofPackManifest): ProofPackSummary {
    return {
      id: manifest.id,
      workflowId: manifest.workflowId,
      ownerId: manifest.ownerId,
      createdAt: manifest.createdAt,
      manifestSha256: manifest.manifestSha256,
      directory: this.packDirectory(manifest.id),
      files: manifest.files.map((file) => ({ ...file })),
    };
  }

  private packDirectory(id: string): string {
    if (!PACK_ID.test(id)) throw new Error('Proof Pack id must be proof_<24 lowercase hex>.');
    const directory = resolve(this.root, id);
    this.assertInside(directory, this.root);
    return directory;
  }

  private assertInside(path: string, root: string): void {
    const normalizedPath = resolve(path);
    const normalizedRoot = resolve(root);
    if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}${sep}`)) {
      throw new Error(`Proof Pack path escapes its root: ${path}`);
    }
  }
}
