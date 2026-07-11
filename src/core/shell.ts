/** Return the platform default shell without assuming a Unix filesystem. */
export function defaultShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform === 'win32') return env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
  return env.SHELL ?? '/bin/bash';
}

/**
 * Build argv for executing one command through a configured shell.
 *
 * The command is passed as a single argument rather than interpolated into a
 * wrapper string. Policy classification still happens before this helper is
 * used by callers.
 */
export function shellCommandArgs(
  shell: string,
  command: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const name = shell.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';

  if (name === 'cmd' || name === 'cmd.exe' || (platform === 'win32' && !name)) {
    // With /s /c, cmd.exe strips the outermost quote pair. Commands that begin
    // with a quoted executable therefore need one additional wrapper pair so the
    // executable and its following quoted arguments remain intact.
    const wrapped = command.trimStart().startsWith('"') ? `"${command}"` : command;
    return ['/d', '/s', '/c', wrapped];
  }

  if (
    name === 'powershell' ||
    name === 'powershell.exe' ||
    name === 'pwsh' ||
    name === 'pwsh.exe'
  ) {
    return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command];
  }

  return ['-lc', command];
}

/** Quote one literal argument for a configured shell command string. */
export function quoteShellArg(
  shell: string,
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  const name = shell.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';

  if (name === 'cmd' || name === 'cmd.exe' || (platform === 'win32' && !name)) {
    // Double percent signs to prevent environment-variable expansion. Double
    // quotes are not valid in Windows path components, but may occur in other
    // literal args, where cmd treats a doubled quote as a literal quote.
    return `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`;
  }

  if (
    name === 'powershell' ||
    name === 'powershell.exe' ||
    name === 'pwsh' ||
    name === 'pwsh.exe'
  ) {
    return `'${value.replace(/'/g, "''")}'`;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}
