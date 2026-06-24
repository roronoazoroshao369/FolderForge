import type { RiskLevel } from '../core/types.js';

/**
 * Patterns that are always blocked (CRITICAL), regardless of policy mode.
 */
const CRITICAL_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\s+\/(?:\s|$)/,
  /\brm\s+-rf?\s+~(?:\/|\s|$)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bchmod\s+-R\s+777\s+\//,
  /\bchown\s+-R\b/,
  /\bcurl\b[^|]*\|\s*(?:bash|sh)\b/,
  /\bwget\b[^|]*\|\s*(?:bash|sh)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+push\b[^&|;]*--force\b/,
  /\bdocker\s+system\s+prune\b/,
  /\bkubectl\s+delete\b/,
  /\bterraform\s+apply\b/,
  /\bmv\s+\S+\s+\/dev\/null\b/,
  /:\(\)\s*\{.*\|.*&\s*\}\s*;/, // fork bomb
];

/**
 * Patterns considered HIGH risk (require approval).
 */
const HIGH_PATTERNS: RegExp[] = [
  /\bgit\s+push\b/,
  /\bgit\s+reset\b/,
  /\bdocker\s+compose\s+down\b/,
  /\bdocker\s+rm\b/,
  /\bnpm\s+publish\b/,
  /\brm\s+-rf?\b/,
];

/**
 * Patterns considered MEDIUM risk (allowed in safe/dev, audited).
 */
const MEDIUM_PATTERNS: RegExp[] = [
  /\bnpm\s+(install|i|ci|add)\b/,
  /\bpnpm\s+(install|add)\b/,
  /\byarn\s+(add|install)\b/,
  /\bpip\s+install\b/,
  /\bdocker\s+compose\s+up\b/,
  /\bmake\b/,
  /\b(npm|pnpm|yarn)\s+run\s+build\b/,
];

export interface CommandClassification {
  risk: RiskLevel;
  blockedReason?: string;
  matched?: string;
}

export class CommandPolicy {
  private blocked: string[];

  constructor(blockedCommands: string[]) {
    this.blocked = blockedCommands;
  }

  /** Substring/glob-ish blocklist from config, on top of the built-in regex set. */
  private matchesConfigBlocklist(command: string): string | undefined {
    const cmd = command.toLowerCase();
    for (const entry of this.blocked) {
      const pat = entry.toLowerCase();
      if (pat.includes('*')) {
        // very loose wildcard: split on '*' and check ordered substrings
        const parts = pat.split('*').filter(Boolean);
        let idx = 0;
        let ok = true;
        for (const p of parts) {
          const found = cmd.indexOf(p.trim(), idx);
          if (found === -1) {
            ok = false;
            break;
          }
          idx = found + p.length;
        }
        if (ok) return entry;
      } else if (cmd.includes(pat)) {
        return entry;
      }
    }
    return undefined;
  }

  classify(command: string): CommandClassification {
    const trimmed = command.trim();

    for (const re of CRITICAL_PATTERNS) {
      if (re.test(trimmed)) {
        return { risk: 'CRITICAL', blockedReason: `Matches destructive pattern: ${re}`, matched: re.source };
      }
    }

    const cfgHit = this.matchesConfigBlocklist(trimmed);
    if (cfgHit) {
      return { risk: 'CRITICAL', blockedReason: `Matches blocked command rule: ${cfgHit}`, matched: cfgHit };
    }

    for (const re of HIGH_PATTERNS) {
      if (re.test(trimmed)) return { risk: 'HIGH', matched: re.source };
    }
    for (const re of MEDIUM_PATTERNS) {
      if (re.test(trimmed)) return { risk: 'MEDIUM', matched: re.source };
    }
    return { risk: 'LOW' };
  }
}
