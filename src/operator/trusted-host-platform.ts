/** Platform and operator I/O preconditions for Fleet trusted-host grants. */
export type OperatorPlatform = 'darwin' | 'linux' | 'unsupported';

export function detectConsentPlatform(platform: string): OperatorPlatform {
  if (platform === 'darwin' || platform === 'linux') return platform;
  return 'unsupported';
}

export function requireSupportedLocalPlatform(platform: string): void {
  if (detectConsentPlatform(platform) !== 'darwin') {
    // macOS is the only initially qualified target. Linux requires its own gate.
    throw new Error('LOCAL_CONFIRMATION_UNAVAILABLE');
  }
}

export function checkLocalTerminal(io: { stdinIsTTY: boolean; stdoutIsTTY: boolean }): void {
  if (!io.stdinIsTTY || !io.stdoutIsTTY) throw new Error('LOCAL_TERMINAL_REQUIRED');
}
