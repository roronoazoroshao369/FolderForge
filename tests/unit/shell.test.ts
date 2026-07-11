import { describe, expect, it } from 'vitest';
import { defaultShell, quoteShellArg, shellCommandArgs } from '../../src/core/shell.js';

describe('cross-platform shell invocation', () => {
  it('uses ComSpec for the Windows default shell', () => {
    expect(defaultShell('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })).toBe(
      'C:\\Windows\\System32\\cmd.exe'
    );
    expect(defaultShell('win32', {})).toBe('cmd.exe');
  });

  it('uses SHELL or bash on POSIX platforms', () => {
    expect(defaultShell('linux', { SHELL: '/bin/zsh' })).toBe('/bin/zsh');
    expect(defaultShell('darwin', {})).toBe('/bin/bash');
  });

  it('builds cmd.exe arguments without POSIX flags', () => {
    expect(shellCommandArgs('C:\\Windows\\System32\\cmd.exe', 'echo hello', 'win32')).toEqual([
      '/d',
      '/s',
      '/c',
      'echo hello',
    ]);
  });

  it('builds PowerShell arguments explicitly', () => {
    expect(shellCommandArgs('pwsh.exe', 'Write-Output hello', 'win32')).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Write-Output hello',
    ]);
  });

  it('quotes literal arguments for each shell family', () => {
    expect(quoteShellArg('cmd.exe', 'C:\\Program Files\\Godot\\godot.exe', 'win32')).toBe(
      '"C:\\Program Files\\Godot\\godot.exe"'
    );
    expect(quoteShellArg('pwsh.exe', "a'b", 'win32')).toBe("'a''b'");
    expect(quoteShellArg('/bin/bash', "a'b", 'linux')).toBe("'a'\\''b'");
  });

  it('keeps login-command semantics for POSIX and Git Bash shells', () => {
    expect(shellCommandArgs('/bin/bash', 'echo hello', 'linux')).toEqual(['-lc', 'echo hello']);
    expect(shellCommandArgs('C:\\Program Files\\Git\\bin\\bash.exe', 'echo hello', 'win32')).toEqual([
      '-lc',
      'echo hello',
    ]);
  });
});
