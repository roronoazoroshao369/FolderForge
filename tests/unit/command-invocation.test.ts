import { describe, expect, it } from 'vitest';
import { commandInvocation } from '../../scripts/command-invocation.mjs';

describe('package-smoke command invocation', () => {
  it('routes Windows command wrappers through ComSpec with verbatim argv', () => {
    const invocation = commandInvocation(
      'C:\\Program Files\\nodejs\\npm.cmd',
      ['install', 'C:\\Temp\\folderforge pack ünicode.tgz'],
      'win32',
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    );

    expect(invocation).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\Program Files\\nodejs\\npm.cmd" "install" "C:\\Temp\\folderforge pack ünicode.tgz""',
      ],
      windowsVerbatimArguments: true,
    });
  });

  it('escapes percent expansion in cmd literals', () => {
    const invocation = commandInvocation(
      'C:\\bin\\folderforge.cmd',
      ['doctor', '--project', 'C:\\Temp\\100% ready'],
      'win32',
      {}
    );

    expect(invocation.command).toBe('cmd.exe');
    expect(invocation.args.at(-1)).toContain('100%% ready');
  });

  it('leaves native and POSIX executables unchanged', () => {
    expect(commandInvocation('/usr/bin/npm', ['pack'], 'linux', {})).toEqual({
      command: '/usr/bin/npm',
      args: ['pack'],
      windowsVerbatimArguments: false,
    });
    expect(commandInvocation('C:\\node\\node.exe', ['--version'], 'win32', {})).toEqual({
      command: 'C:\\node\\node.exe',
      args: ['--version'],
      windowsVerbatimArguments: false,
    });
  });
});
