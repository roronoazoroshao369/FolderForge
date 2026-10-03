import { delimiter, dirname } from "node:path";

/**
 * Keep child commands on the same Node.js runtime as the FolderForge process.
 * This matters when FolderForge was launched through an absolute NVM binary but
 * inherited a PATH whose `node` still resolves to an older system installation.
 */
export function ensureRuntimeNodeOnPath(
  env: NodeJS.ProcessEnv = process.env,
  execPath = process.execPath,
): string {
  const runtimeBin = dirname(execPath);
  const entries = (env.PATH ?? "").split(delimiter).filter(Boolean);

  if (!entries.includes(runtimeBin)) {
    entries.unshift(runtimeBin);
    env.PATH = entries.join(delimiter);
  }

  return env.PATH ?? runtimeBin;
}
