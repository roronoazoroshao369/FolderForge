import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { checkLocalTerminal, requireSupportedLocalPlatform } from './trusted-host-platform.js';
import { TrustedHostStore } from './trusted-host-store.js';

export interface OperatorCliIO {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  osUid: number;
  print(text: string): void;
  ask(question: string): Promise<string>;
}

export interface OperatorCliResult {
  exitCode: number;
  output: string;
}

export async function runTrustedHostOperatorCli(
  args: string[], io: OperatorCliIO, store: TrustedHostStore,
): Promise<OperatorCliResult> {
  const [verb, id] = args;
  if (args.length !== 2 || !id || (verb !== 'approve' && verb !== 'revoke')) {
    return { exitCode: 2, output: 'Usage: folderforge operator trusted-host approve <request-id> | revoke <scope-hash>\n' };
  }
  try {
    checkLocalTerminal(io);
    if (verb === 'approve') {
      const pending = store.readPending(id);
      if (!pending) throw new Error('CONSENT_REQUEST_UNAVAILABLE');
      if (io.osUid !== pending.identity.serviceUid) throw new Error('WRONG_OPERATOR_UID');
      const details = [
        'Trusted host execution requires local operator consent.',
        `Fleet instance: ${pending.instanceId}`,
        `Project: ${pending.identity.workspaceRealpath}`,
        `Preset: ${pending.tuple.toolsPreset}`,
        `Policy: ${pending.tuple.policyMode}`,
        `Execution: ${pending.tuple.terminalExecution}`,
        'Commands will execute as the FolderForge OS account; audit and hard-denies still apply.',
      ].join('\n');
      io.print(details);
      const answer = await io.ask(`Type APPROVE ${pending.instanceId} to proceed: `);
      if (answer !== `APPROVE ${pending.instanceId}`) {
        return { exitCode: 1, output: 'Local operator confirmation declined.\n' };
      }
      store.consumeLocalApproval(pending.requestId, pending.scopeHash);
      return { exitCode: 0, output: `${details}\nLocal consent recorded for ${pending.instanceId}.\n` };
    }
    const grant = store.readGrantByScope(id);
    if (!grant) throw new Error('CONSENT_GRANT_UNAVAILABLE');
    if (io.osUid !== grant.identity.serviceUid) throw new Error('WRONG_OPERATOR_UID');
    io.print(`Revoke trusted host grant for ${grant.instanceId} (${grant.identity.workspaceRealpath})`);
    if ((await io.ask(`Type REVOKE ${grant.instanceId} to proceed: `)) !== `REVOKE ${grant.instanceId}`) {
      return { exitCode: 1, output: 'Local operator revocation declined.\n' };
    }
    store.revoke(grant.identity);
    return { exitCode: 0, output: `Local grant revoked for ${grant.instanceId}; stop any existing trusted-host child separately.\n` };
  } catch (error) {
    return { exitCode: 1, output: `Operator confirmation unavailable: ${error instanceof Error ? error.message : String(error)}\n` };
  }
}

/** On macOS, this directory is outside the project and not exposed via Fleet YAML. */
export function defaultHostConsentRoot(): string {
  return join(homedir(), 'Library', 'Application Support', 'FolderForge', 'operator-consent');
}

export async function executeHostOperatorCli(args: string[]): Promise<OperatorCliResult> {
  requireSupportedLocalPlatform(process.platform);
  if (typeof process.getuid !== 'function') throw new Error('LOCAL_CONFIRMATION_UNAVAILABLE');
  const uid = process.getuid();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const io: OperatorCliIO = {
      stdinIsTTY: process.stdin.isTTY === true,
      stdoutIsTTY: process.stdout.isTTY === true,
      osUid: uid,
      print: (value) => process.stdout.write(`${value}\n`),
      ask: async (prompt) => readline.question(prompt),
    };
    const store = new TrustedHostStore({ operatorRoot: defaultHostConsentRoot(), currentUid: uid, now: Date.now });
    return runTrustedHostOperatorCli(args, io, store);
  } finally {
    readline.close();
  }
}
