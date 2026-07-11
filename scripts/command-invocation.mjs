import { basename } from 'node:path';

function quoteCmdLiteral(value) {
  return `"${String(value).replace(/%/g, '%%').replace(/"/g, '""')}"`;
}

/**
 * Build a spawn-safe invocation for executable wrappers.
 *
 * Windows `.cmd`/`.bat` files are scripts, not native executables. Invoking them
 * directly through spawnSync is inconsistent across Node versions. Route them
 * through ComSpec with the complete command line wrapped for `/s /c`, and tell
 * Node not to perform a second quoting pass.
 */
export function commandInvocation(
  command,
  args = [],
  platform = process.platform,
  env = process.env
) {
  const isWindowsScript =
    platform === 'win32' && /\.(?:cmd|bat)$/i.test(basename(String(command)));
  if (!isWindowsScript) {
    return { command, args, windowsVerbatimArguments: false };
  }

  const shell = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
  const commandLine = [command, ...args].map(quoteCmdLiteral).join(' ');
  return {
    command: shell,
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}
