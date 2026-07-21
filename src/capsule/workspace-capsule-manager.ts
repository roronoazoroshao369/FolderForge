import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  CapsuleEnforcement,
  RiskLevel,
  ToolPrincipal,
} from '../core/types.js';
import { projectPrincipalId } from '../core/principal.js';

export type PermissionProfile = 'observe' | 'propose' | 'develop' | 'autopilot';
export type CapsuleIsolation = 'direct' | 'checkpoint' | 'worktree';
export type CapsuleNetworkPolicy = 'none' | 'restricted';
export type ClientCompatibilityProfile = 'chatgpt' | 'claude' | 'generic';

export interface CapsuleLimits {
  maxCalls: number;
  maxMutations: number;
  maxFilesPerCall: number;
  maxCommandLength: number;
}

export interface WorkspaceCapsule {
  id: string;
  workspaceRoot: string;
  workspaceId: string;
  principalId: string;
  projectId: string;
  sessionId?: string;
  clientId?: string;
  taskId?: string;
  profile: PermissionProfile;
  grantedScopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedBy?: string;
  isolation: CapsuleIsolation;
  networkPolicy: CapsuleNetworkPolicy;
  limits: CapsuleLimits;
  evidenceDestination: string;
  clientCompatibility: ClientCompatibilityProfile;
  usage: {
    calls: number;
    mutations: number;
    lastUsedAt?: string;
  };
}

export interface CreateCapsuleInput {
  workspaceRoot: string;
  principalId: string;
  profile: PermissionProfile;
  ttlMs?: number;
  sessionId?: string;
  clientId?: string;
  taskId?: string;
  grantedScopes?: string[];
  isolation?: CapsuleIsolation;
  networkPolicy?: CapsuleNetworkPolicy;
  limits?: Partial<CapsuleLimits>;
  evidenceDestination?: string;
  clientCompatibility?: ClientCompatibilityProfile;
}

export interface CapsuleDecision {
  kind: 'allow' | 'deny';
  capsule?: WorkspaceCapsule;
  reason?: string;
}

interface CapsuleStore {
  version: 1;
  capsules: WorkspaceCapsule[];
  digest: string;
}

const PROFILE_DEFAULTS: Record<PermissionProfile, {
  isolation: CapsuleIsolation;
  networkPolicy: CapsuleNetworkPolicy;
  limits: CapsuleLimits;
}> = {
  observe: {
    isolation: 'direct',
    networkPolicy: 'none',
    limits: { maxCalls: 500, maxMutations: 0, maxFilesPerCall: 25, maxCommandLength: 0 },
  },
  propose: {
    isolation: 'worktree',
    networkPolicy: 'none',
    limits: { maxCalls: 1_500, maxMutations: 300, maxFilesPerCall: 50, maxCommandLength: 2_000 },
  },
  develop: {
    isolation: 'checkpoint',
    networkPolicy: 'restricted',
    limits: { maxCalls: 3_000, maxMutations: 1_000, maxFilesPerCall: 100, maxCommandLength: 8_000 },
  },
  autopilot: {
    isolation: 'worktree',
    networkPolicy: 'restricted',
    limits: { maxCalls: 5_000, maxMutations: 2_000, maxFilesPerCall: 150, maxCommandLength: 8_000 },
  },
};

const NEVER_AUTONOMOUS = new Set([
  'git_push',
  'git_reset',
  'marketplace_sync',
  'marketplace_install',
  'marketplace_package',
]);

const NETWORK_COMMAND = /(^|[;&|\s])(curl|wget|ssh|scp|rsync|npm\s+(install|add|publish)|pnpm\s+(add|install|publish)|yarn\s+(add|install|publish)|pip\s+install|git\s+(fetch|pull|push))([;&|\s]|$)/i;


function canonicalizePath(input: string): string {
  const absolute = resolve(input);
  let probe = absolute;
  const suffix: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return absolute;
    suffix.unshift(basename(probe));
    probe = parent;
  }
  try {
    const real = realpathSync(probe);
    return suffix.length > 0 ? resolve(real, ...suffix) : real;
  } catch {
    return absolute;
  }
}

function workspaceId(root: string): string {
  return `workspace:${createHash('sha256').update(resolve(root)).digest('hex').slice(0, 24)}`;
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function cloneCapsule(capsule: WorkspaceCapsule): WorkspaceCapsule {
  return structuredClone(capsule);
}

function storeDigest(capsules: WorkspaceCapsule[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(capsules)).digest('hex')}`;
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function pathLikeValues(value: unknown, key = ''): string[] {
  if (typeof value === 'string') {
    return /(^|_)(path|file|from|to|cwd|root|output|source|target)s?$/i.test(key)
      ? [value]
      : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => pathLikeValues(item, key));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([childKey, child]) =>
    pathLikeValues(child, childKey),
  );
}

export class WorkspaceCapsuleManager {
  private readonly capsules = new Map<string, WorkspaceCapsule>();
  private readonly persistPath: string;

  constructor(
    private readonly allowedDirectories: string[],
    private readonly enforcement: CapsuleEnforcement,
    private readonly defaultTtlMs: number,
    private readonly maxTtlMs: number,
    projectRoot: string,
    private readonly isManagedWorktree: (root: string) => boolean = () => false,
    private readonly managedWorktreeForPath: (path: string) => string | undefined = () => undefined,
  ) {
    this.persistPath = resolve(projectRoot, '.folderforge', 'capsules.json');
    this.load();
  }

  create(input: CreateCapsuleInput): WorkspaceCapsule {
    const root = resolve(input.workspaceRoot);
    this.assertAllowedRoot(root);
    if (!input.principalId.trim()) throw new Error('principalId is required.');
    if (!Object.hasOwn(PROFILE_DEFAULTS, input.profile)) {
      throw new Error(`Unknown permission profile: ${input.profile}`);
    }
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > this.maxTtlMs) {
      throw new Error(`ttlMs must be between 1000 and ${this.maxTtlMs}.`);
    }
    const defaults = PROFILE_DEFAULTS[input.profile];
    const isolation = input.isolation ?? defaults.isolation;
    if (!['direct', 'checkpoint', 'worktree'].includes(isolation)) {
      throw new Error(`Unknown capsule isolation: ${String(isolation)}`);
    }
    const networkPolicy = input.networkPolicy ?? defaults.networkPolicy;
    if (!['none', 'restricted'].includes(networkPolicy)) {
      throw new Error(`Unknown capsule network policy: ${String(networkPolicy)}`);
    }
    const clientCompatibility = input.clientCompatibility ?? 'generic';
    if (!['chatgpt', 'claude', 'generic'].includes(clientCompatibility)) {
      throw new Error(`Unknown client compatibility profile: ${String(clientCompatibility)}`);
    }
    const limits = { ...defaults.limits, ...(input.limits ?? {}) };
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`limits.${name} must be a non-negative integer.`);
      }
    }
    if (input.profile === 'observe' && limits.maxMutations !== 0) {
      throw new Error('Observe capsules must have maxMutations=0.');
    }
    const createdAt = new Date();
    const capsule: WorkspaceCapsule = {
      id: `caps_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      workspaceRoot: root,
      workspaceId: workspaceId(root),
      principalId: input.principalId.trim(),
      projectId: projectPrincipalId(root),
      ...(input.sessionId?.trim() ? { sessionId: input.sessionId.trim() } : {}),
      ...(input.clientId?.trim() ? { clientId: input.clientId.trim() } : {}),
      ...(input.taskId?.trim() ? { taskId: input.taskId.trim() } : {}),
      profile: input.profile,
      grantedScopes: uniqueStrings(input.grantedScopes),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
      isolation,
      networkPolicy,
      limits,
      evidenceDestination: resolve(
        root,
        input.evidenceDestination ?? '.folderforge/evidence',
      ),
      clientCompatibility,
      usage: { calls: 0, mutations: 0 },
    };
    this.assertEvidenceDestination(capsule);
    this.capsules.set(capsule.id, capsule);
    this.persist();
    return cloneCapsule(capsule);
  }

  list(): WorkspaceCapsule[] {
    return [...this.capsules.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneCapsule);
  }

  get(id: string): WorkspaceCapsule | undefined {
    const capsule = this.capsules.get(id);
    return capsule ? cloneCapsule(capsule) : undefined;
  }

  revoke(id: string, actorId: string): WorkspaceCapsule | undefined {
    const capsule = this.capsules.get(id);
    if (!capsule) return undefined;
    if (!capsule.revokedAt) {
      capsule.revokedAt = new Date().toISOString();
      capsule.revokedBy = actorId;
      this.persist();
    }
    return cloneCapsule(capsule);
  }

  matching(principal: ToolPrincipal, projectRoot: string): WorkspaceCapsule | undefined {
    const decision = this.resolveBinding(principal, projectRoot);
    return decision.kind === 'allow' && decision.capsule
      ? cloneCapsule(decision.capsule)
      : undefined;
  }

  check(
    principal: ToolPrincipal,
    projectRoot: string,
    call: {
      name: string;
      group?: string;
      risk: RiskLevel;
      mutates: boolean;
      args: Record<string, unknown>;
    },
  ): CapsuleDecision {
    const binding = this.resolveBinding(principal, projectRoot);
    if (binding.kind === 'deny') return binding;
    const capsule = binding.capsule;
    if (!capsule) return { kind: 'allow' };

    if (capsule.grantedScopes.length > 0) {
      const exact = `tool:${call.name}`;
      const group = `group:${call.group ?? 'dynamic'}`;
      const broad = call.mutates ? 'tools:write' : 'tools:read';
      if (
        !capsule.grantedScopes.includes(exact) &&
        !capsule.grantedScopes.includes(group) &&
        !capsule.grantedScopes.includes(broad)
      ) {
        return {
          kind: 'deny',
          capsule,
          reason: `Capsule scope does not grant ${call.name} (${broad}).`,
        };
      }
    }

    if (capsule.profile === 'observe' && call.mutates) {
      return { kind: 'deny', capsule, reason: 'Observe profile blocks all mutations.' };
    }
    if (
      (capsule.profile === 'propose' || capsule.profile === 'autopilot') &&
      call.mutates &&
      (capsule.isolation !== 'worktree' || !this.isManagedWorktree(capsule.workspaceRoot))
    ) {
      return {
        kind: 'deny',
        capsule,
        reason: `${capsule.profile} profile permits mutations only inside a verified managed worktree.`,
      };
    }
    if (NEVER_AUTONOMOUS.has(call.name)) {
      return {
        kind: 'deny',
        capsule,
        reason: `${call.name} is outside every capsule autonomous boundary.`,
      };
    }
    if (capsule.profile === 'autopilot' && call.risk === 'CRITICAL') {
      return {
        kind: 'deny',
        capsule,
        reason: 'Autopilot capsules cannot execute CRITICAL operations.',
      };
    }
    if (capsule.usage.calls >= capsule.limits.maxCalls) {
      return { kind: 'deny', capsule, reason: 'Capsule call budget exhausted.' };
    }
    if (call.mutates && capsule.usage.mutations >= capsule.limits.maxMutations) {
      return { kind: 'deny', capsule, reason: 'Capsule mutation budget exhausted.' };
    }
    const referencedPaths = [...new Set(pathLikeValues(call.args))];
    const capsuleRoot = canonicalizePath(capsule.workspaceRoot);
    for (const value of referencedPaths) {
      const target = canonicalizePath(
        isAbsolute(value) ? resolve(value) : resolve(projectRoot, value),
      );
      const rel = relative(capsuleRoot, target);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return {
          kind: 'deny',
          capsule,
          reason: `Call path escapes the capsule workspace: ${value}`,
        };
      }
      const managedRoot = this.managedWorktreeForPath(target);
      if (managedRoot && canonicalizePath(managedRoot) !== capsuleRoot) {
        return {
          kind: 'deny',
          capsule,
          reason: `Call path enters a different managed worktree: ${value}`,
        };
      }
    }
    const fileCount = referencedPaths.length;
    if (fileCount > capsule.limits.maxFilesPerCall) {
      return {
        kind: 'deny',
        capsule,
        reason: `Call references ${fileCount} files; capsule limit is ${capsule.limits.maxFilesPerCall}.`,
      };
    }
    const commandTools = new Set([
      'shell_exec', 'process_start', 'project_verify', 'run_test', 'run_lint',
      'run_typecheck', 'run_build', 'run_coverage', 'pkg_run', 'pkg_add',
      'pkg_remove', 'format_check', 'format_apply',
    ]);
    if (commandTools.has(call.name)) {
      return {
        kind: 'deny',
        capsule,
        reason: 'Command execution is disabled in capsules until the process sandbox is active.',
      };
    }
    const networkTools = new Set([
      ...commandTools, 'git_fetch', 'git_pull', 'git_push', 'browser_open',
      'db_connect', 'plugin_install', 'plugin_update', 'marketplace_sync',
      'marketplace_install', 'distributed_worker_register',
    ]);
    if (capsule.networkPolicy === 'none' && networkTools.has(call.name)) {
      return { kind: 'deny', capsule, reason: 'Capsule network policy blocks this tool.' };
    }
    if (call.name === 'shell_exec' || call.name === 'process_start') {
      const command = String(call.args.command ?? '');
      if (capsule.limits.maxCommandLength === 0 && command) {
        return { kind: 'deny', capsule, reason: 'This capsule profile blocks commands.' };
      }
      if (command.length > capsule.limits.maxCommandLength) {
        return { kind: 'deny', capsule, reason: 'Command exceeds the capsule length limit.' };
      }
      if (capsule.networkPolicy === 'none' && NETWORK_COMMAND.test(command)) {
        return { kind: 'deny', capsule, reason: 'Capsule network policy blocks this command.' };
      }
    }
    return { kind: 'allow', capsule };
  }

  reserve(id: string, mutates: boolean): WorkspaceCapsule {
    const capsule = this.capsules.get(id);
    if (!capsule) throw new Error(`Capsule not found: ${id}`);
    if (capsule.usage.calls >= capsule.limits.maxCalls) {
      throw new Error('Capsule call budget exhausted.');
    }
    if (mutates && capsule.usage.mutations >= capsule.limits.maxMutations) {
      throw new Error('Capsule mutation budget exhausted.');
    }
    capsule.usage.calls += 1;
    if (mutates) capsule.usage.mutations += 1;
    capsule.usage.lastUsedAt = new Date().toISOString();
    this.persist();
    return cloneCapsule(capsule);
  }

  describe(): {
    enforcement: CapsuleEnforcement;
    total: number;
    active: number;
    expired: number;
    revoked: number;
  } {
    const now = Date.now();
    const values = [...this.capsules.values()];
    return {
      enforcement: this.enforcement,
      total: values.length,
      active: values.filter((item) => !item.revokedAt && Date.parse(item.expiresAt) > now).length,
      expired: values.filter((item) => !item.revokedAt && Date.parse(item.expiresAt) <= now).length,
      revoked: values.filter((item) => Boolean(item.revokedAt)).length,
    };
  }

  private resolveBinding(principal: ToolPrincipal, projectRoot: string): CapsuleDecision {
    if (principal.role === 'admin') return { kind: 'allow' };
    const root = resolve(projectRoot);
    const expectedProjectId = principal.projectId ?? projectPrincipalId(root);
    const candidates = [...this.capsules.values()].filter(
      (capsule) => capsule.workspaceRoot === root && capsule.principalId === principal.id,
    );
    if (candidates.length === 0) {
      const remote = principal.authMode === 'token' || principal.authMode === 'oauth';
      if (this.enforcement === 'all' || (this.enforcement === 'remote' && remote)) {
        return { kind: 'deny', reason: 'An active Workspace Capsule is required for this principal.' };
      }
      return { kind: 'allow' };
    }

    const bound = candidates
      .filter(
        (capsule) =>
          capsule.projectId === expectedProjectId &&
          (!capsule.sessionId || capsule.sessionId === principal.sessionId) &&
          (!capsule.clientId || capsule.clientId === principal.oauthClientId),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .find((capsule) => !capsule.revokedAt && Date.parse(capsule.expiresAt) > Date.now())
      ?? candidates
        .filter(
          (capsule) =>
            capsule.projectId === expectedProjectId &&
            (!capsule.sessionId || capsule.sessionId === principal.sessionId) &&
            (!capsule.clientId || capsule.clientId === principal.oauthClientId),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!bound) {
      return {
        kind: 'deny',
        reason: 'Workspace Capsule binding does not match this project, session, or client.',
      };
    }
    if (bound.revokedAt) {
      return { kind: 'deny', capsule: bound, reason: 'Workspace Capsule has been revoked.' };
    }
    if (Date.parse(bound.expiresAt) <= Date.now()) {
      return { kind: 'deny', capsule: bound, reason: 'Workspace Capsule has expired.' };
    }
    return { kind: 'allow', capsule: bound };
  }

  private assertAllowedRoot(root: string): void {
    const allowed = this.allowedDirectories.some((directory) => {
      const candidate = resolve(directory);
      return root === candidate || root.startsWith(`${candidate}${sep}`);
    });
    if (!allowed) throw new Error(`Capsule workspace is outside allowed directories: ${root}`);
  }

  private assertEvidenceDestination(capsule: WorkspaceCapsule): void {
    const target = resolve(capsule.evidenceDestination);
    if (target !== capsule.workspaceRoot && !target.startsWith(`${capsule.workspaceRoot}${sep}`)) {
      throw new Error('Capsule evidence destination must stay inside the workspace root.');
    }
  }

  private validatePersistedCapsule(value: unknown): WorkspaceCapsule {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Capsule store contains an invalid entry.');
    }
    const capsule = value as WorkspaceCapsule;
    if (!/^caps_[a-f0-9]{20}$/.test(capsule.id)) throw new Error('Capsule id is invalid.');
    if (typeof capsule.workspaceRoot !== 'string') throw new Error('Capsule workspaceRoot is invalid.');
    capsule.workspaceRoot = resolve(capsule.workspaceRoot);
    this.assertAllowedRoot(capsule.workspaceRoot);
    if (capsule.workspaceId !== workspaceId(capsule.workspaceRoot)) {
      throw new Error('Capsule workspace identity does not match its root.');
    }
    if (capsule.projectId !== projectPrincipalId(capsule.workspaceRoot)) {
      throw new Error('Capsule project identity does not match its root.');
    }
    if (typeof capsule.principalId !== 'string' || !capsule.principalId.trim()) {
      throw new Error('Capsule principalId is invalid.');
    }
    if (!Object.hasOwn(PROFILE_DEFAULTS, capsule.profile)) throw new Error('Capsule profile is invalid.');
    if (!['direct', 'checkpoint', 'worktree'].includes(capsule.isolation)) {
      throw new Error('Capsule isolation is invalid.');
    }
    if (!['none', 'restricted'].includes(capsule.networkPolicy)) {
      throw new Error('Capsule network policy is invalid.');
    }
    if (!['chatgpt', 'claude', 'generic'].includes(capsule.clientCompatibility)) {
      throw new Error('Capsule compatibility profile is invalid.');
    }
    if (!Array.isArray(capsule.grantedScopes) || capsule.grantedScopes.some((scope) => typeof scope !== 'string')) {
      throw new Error('Capsule scopes are invalid.');
    }
    capsule.grantedScopes = uniqueStrings(capsule.grantedScopes);
    if (!validDate(capsule.createdAt) || !validDate(capsule.expiresAt)) {
      throw new Error('Capsule timestamps are invalid.');
    }
    if (Date.parse(capsule.expiresAt) <= Date.parse(capsule.createdAt)) {
      throw new Error('Capsule expiry must follow creation.');
    }
    if (capsule.revokedAt !== undefined && !validDate(capsule.revokedAt)) {
      throw new Error('Capsule revocation timestamp is invalid.');
    }
    if (!capsule.limits || typeof capsule.limits !== 'object') throw new Error('Capsule limits are invalid.');
    for (const [name, limit] of Object.entries(capsule.limits)) {
      if (!nonNegativeInteger(limit)) throw new Error(`Capsule limit ${name} is invalid.`);
    }
    if (capsule.profile === 'observe' && capsule.limits.maxMutations !== 0) {
      throw new Error('Observe capsule mutation limit is invalid.');
    }
    if (!capsule.usage || !nonNegativeInteger(capsule.usage.calls) || !nonNegativeInteger(capsule.usage.mutations)) {
      throw new Error('Capsule usage counters are invalid.');
    }
    if (capsule.usage.calls > capsule.limits.maxCalls || capsule.usage.mutations > capsule.limits.maxMutations) {
      throw new Error('Capsule usage exceeds its persisted limits.');
    }
    if (capsule.usage.lastUsedAt !== undefined && !validDate(capsule.usage.lastUsedAt)) {
      throw new Error('Capsule last-used timestamp is invalid.');
    }
    if (typeof capsule.evidenceDestination !== 'string') {
      throw new Error('Capsule evidence destination is invalid.');
    }
    capsule.evidenceDestination = resolve(capsule.evidenceDestination);
    this.assertEvidenceDestination(capsule);
    return capsule;
  }

  private load(): void {
    if (!existsSync(this.persistPath)) return;
    const parsed = JSON.parse(readFileSync(this.persistPath, 'utf8')) as CapsuleStore;
    if (parsed.version !== 1 || !Array.isArray(parsed.capsules) || typeof parsed.digest !== 'string') {
      throw new Error('Unsupported or invalid capsule state file.');
    }
    if (parsed.digest !== storeDigest(parsed.capsules)) {
      throw new Error('Capsule state integrity check failed.');
    }
    const seen = new Set<string>();
    for (const value of parsed.capsules) {
      const capsule = this.validatePersistedCapsule(value);
      if (seen.has(capsule.id)) throw new Error(`Duplicate capsule id: ${capsule.id}`);
      seen.add(capsule.id);
      this.capsules.set(capsule.id, capsule);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.persistPath), { recursive: true, mode: 0o700 });
    const temp = `${this.persistPath}.${process.pid}.${randomUUID()}.tmp`;
    const capsules = this.list();
    const state: CapsuleStore = { version: 1, capsules, digest: storeDigest(capsules) };
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.persistPath);
  }
}
