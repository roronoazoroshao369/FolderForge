import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  PolicyMode,
  RiskLevel,
  ToolPrincipal,
} from '../core/types.js';
import picomatchLite from './glob-match.js';

export type PolicyRuleEffect = 'deny' | 'approval';

export interface PolicyRulePrincipalSelector {
  ids?: string[];
  roles?: string[];
  organizationIds?: string[];
  teamIds?: string[];
  projectIds?: string[];
  sessionIds?: string[];
}

export interface PolicyRule {
  id: string;
  effect: PolicyRuleEffect;
  tools: string[];
  risks?: RiskLevel[];
  mutates?: boolean;
  modes?: PolicyMode[];
  principals?: PolicyRulePrincipalSelector;
  reason: string;
}

interface LoadedRule extends PolicyRule {
  source: string;
}

export interface PolicyRuleContext {
  tool: string;
  risk: RiskLevel;
  mutates: boolean;
  mode: PolicyMode;
  principal: ToolPrincipal;
}

export interface PolicyRuleMatch {
  effect: PolicyRuleEffect;
  ruleId: string;
  reason: string;
  source: string;
}

const RISK_LEVELS: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const POLICY_MODES: PolicyMode[] = ['readonly', 'safe', 'dev', 'danger'];
const DOCUMENT_KEYS = new Set(['version', 'name', 'rules']);
const RULE_KEYS = new Set([
  'id',
  'effect',
  'tools',
  'risks',
  'mutates',
  'modes',
  'principals',
  'reason',
]);
const PRINCIPAL_KEYS = new Set([
  'ids',
  'roles',
  'organizationIds',
  'teamIds',
  'projectIds',
  'sessionIds',
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown key(s): ${unknown.join(', ')}.`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function stringArray(value: unknown, label: string, required = false): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string array.`);
  }
  const normalized = value.map((item, index) => nonEmptyString(item, `${label}[${index}]`));
  return [...new Set(normalized)];
}

function enumArray<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T[] | undefined {
  const values = stringArray(value, label);
  if (!values) return undefined;
  const invalid = values.filter((item) => !allowed.includes(item as T));
  if (invalid.length > 0) {
    throw new Error(`${label} contains invalid value(s): ${invalid.join(', ')}.`);
  }
  return values as T[];
}

function parsePrincipalSelector(value: unknown, label: string): PolicyRulePrincipalSelector | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, label);
  rejectUnknownKeys(raw, PRINCIPAL_KEYS, label);
  const ids = stringArray(raw.ids, `${label}.ids`);
  const roles = stringArray(raw.roles, `${label}.roles`);
  const organizationIds = stringArray(raw.organizationIds, `${label}.organizationIds`);
  const teamIds = stringArray(raw.teamIds, `${label}.teamIds`);
  const projectIds = stringArray(raw.projectIds, `${label}.projectIds`);
  const sessionIds = stringArray(raw.sessionIds, `${label}.sessionIds`);
  const result: PolicyRulePrincipalSelector = {
    ...(ids ? { ids } : {}),
    ...(roles ? { roles } : {}),
    ...(organizationIds ? { organizationIds } : {}),
    ...(teamIds ? { teamIds } : {}),
    ...(projectIds ? { projectIds } : {}),
    ...(sessionIds ? { sessionIds } : {}),
  };
  if (Object.keys(result).length === 0) {
    throw new Error(`${label} must contain at least one selector.`);
  }
  return result;
}

function parseRule(value: unknown, source: string, index: number): LoadedRule {
  const label = `${source}: rules[${index}]`;
  const raw = object(value, label);
  rejectUnknownKeys(raw, RULE_KEYS, label);
  const effect = nonEmptyString(raw.effect, `${label}.effect`);
  if (effect !== 'deny' && effect !== 'approval') {
    throw new Error(`${label}.effect must be deny or approval; allow rules are intentionally unsupported.`);
  }
  if (raw.mutates !== undefined && typeof raw.mutates !== 'boolean') {
    throw new Error(`${label}.mutates must be boolean when provided.`);
  }
  const risks = enumArray(raw.risks, `${label}.risks`, RISK_LEVELS);
  const modes = enumArray(raw.modes, `${label}.modes`, POLICY_MODES);
  const principals = parsePrincipalSelector(raw.principals, `${label}.principals`);
  return {
    id: nonEmptyString(raw.id, `${label}.id`),
    effect,
    tools: stringArray(raw.tools, `${label}.tools`, true)!,
    ...(risks ? { risks } : {}),
    ...(raw.mutates !== undefined ? { mutates: raw.mutates } : {}),
    ...(modes ? { modes } : {}),
    ...(principals ? { principals } : {}),
    reason: nonEmptyString(raw.reason, `${label}.reason`),
    source,
  };
}

function parseDocument(path: string): LoadedRule[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse policy file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = object(parsed, path);
  rejectUnknownKeys(raw, DOCUMENT_KEYS, path);
  if (raw.version !== 1) throw new Error(`${path}: version must be 1.`);
  if (raw.name !== undefined) nonEmptyString(raw.name, `${path}.name`);
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) {
    throw new Error(`${path}: rules must be a non-empty array.`);
  }
  return raw.rules.map((rule, index) => parseRule(rule, path, index));
}

function withinProject(projectRoot: string, candidate: string): boolean {
  const rel = relative(projectRoot, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function collectFiles(projectRoot: string, configured: string[]): string[] {
  const candidates = [resolve(projectRoot, '.folderforge', 'policies'), ...configured.map((item) => resolve(projectRoot, item))];
  const files = new Set<string>();
  for (const candidate of candidates) {
    if (!withinProject(projectRoot, candidate)) {
      throw new Error(`Policy path must stay inside the project root: ${candidate}`);
    }
    if (!existsSync(candidate)) {
      if (candidate.endsWith('.yaml') || candidate.endsWith('.yml')) {
        throw new Error(`Configured policy file does not exist: ${candidate}`);
      }
      continue;
    }
    const stat = statSync(candidate);
    if (stat.isFile()) {
      if (!/\.ya?ml$/i.test(candidate)) throw new Error(`Policy file must use .yaml or .yml: ${candidate}`);
      files.add(candidate);
      continue;
    }
    if (!stat.isDirectory()) throw new Error(`Policy path must be a file or directory: ${candidate}`);
    for (const name of readdirSync(candidate).sort()) {
      const path = resolve(candidate, name);
      if (/\.ya?ml$/i.test(name) && statSync(path).isFile()) files.add(path);
    }
  }
  return [...files].sort();
}

function anyPattern(patterns: string[] | undefined, values: string[]): boolean {
  if (!patterns) return true;
  return patterns.some((pattern) => values.some((value) => picomatchLite(pattern, value)));
}

function matches(rule: LoadedRule, context: PolicyRuleContext): boolean {
  if (!anyPattern(rule.tools, [context.tool])) return false;
  if (rule.risks && !rule.risks.includes(context.risk)) return false;
  if (rule.mutates !== undefined && rule.mutates !== context.mutates) return false;
  if (rule.modes && !rule.modes.includes(context.mode)) return false;
  const selectors = rule.principals;
  if (!selectors) return true;
  if (!anyPattern(selectors.ids, [context.principal.id])) return false;
  if (!anyPattern(selectors.roles, [context.principal.role, ...(context.principal.roles ?? [])])) return false;
  if (selectors.organizationIds) {
    if (!context.principal.organizationId) return false;
    if (!anyPattern(selectors.organizationIds, [context.principal.organizationId])) return false;
  }
  if (selectors.teamIds) {
    if (!context.principal.teamIds?.length) return false;
    if (!anyPattern(selectors.teamIds, context.principal.teamIds)) return false;
  }
  if (selectors.projectIds) {
    if (!context.principal.projectId) return false;
    if (!anyPattern(selectors.projectIds, [context.principal.projectId])) return false;
  }
  if (selectors.sessionIds) {
    if (!context.principal.sessionId) return false;
    if (!anyPattern(selectors.sessionIds, [context.principal.sessionId])) return false;
  }
  return true;
}

export class PolicyAsCode {
  readonly files: string[];
  private readonly rules: LoadedRule[];

  constructor(projectRoot: string, configuredFiles: string[] = []) {
    this.files = collectFiles(resolve(projectRoot), configuredFiles);
    const ids = new Map<string, string>();
    this.rules = this.files.flatMap((path) => parseDocument(path));
    for (const rule of this.rules) {
      const prior = ids.get(rule.id);
      if (prior) throw new Error(`Duplicate policy rule id ${rule.id} in ${prior} and ${rule.source}.`);
      ids.set(rule.id, rule.source);
    }
  }

  evaluate(context: PolicyRuleContext): PolicyRuleMatch | undefined {
    const matched = this.rules.filter((rule) => matches(rule, context));
    const rule = matched.find((candidate) => candidate.effect === 'deny') ?? matched[0];
    if (!rule) return undefined;
    return {
      effect: rule.effect,
      ruleId: rule.id,
      reason: `${rule.reason} (policy rule ${rule.id})`,
      source: rule.source,
    };
  }

  describe(): { files: string[]; ruleCount: number; effects: Record<PolicyRuleEffect, number> } {
    return {
      files: [...this.files],
      ruleCount: this.rules.length,
      effects: {
        deny: this.rules.filter((rule) => rule.effect === 'deny').length,
        approval: this.rules.filter((rule) => rule.effect === 'approval').length,
      },
    };
  }
}
