import { describe, expect, it } from 'vitest';
import { posix, win32 } from 'node:path';
import { isPathWithin, samePath } from '../../src/core/path-identity.js';

describe('path identity semantics', () => {
  it('uses segment-aware POSIX containment', () => {
    expect(isPathWithin('/var/project', '/var/project/src', posix)).toBe(true);
    expect(isPathWithin('/var/project', '/var/project-escape', posix)).toBe(false);
    expect(samePath('/private/var/project', '/private/var/project', posix)).toBe(true);
    expect(samePath('/var/project', '/private/var/project', posix)).toBe(false);
  });

  it('uses Windows drive, slash, case, and UNC semantics without blanket lowercasing', () => {
    expect(isPathWithin('C:\\Repo', 'c:/repo/src', win32)).toBe(true);
    expect(isPathWithin('C:\\Repo', 'C:\\Repo2', win32)).toBe(false);
    expect(samePath('C:\\Repo', 'c:/repo', win32)).toBe(true);
    expect(isPathWithin('\\\\server\\share\\repo', '\\\\SERVER\\SHARE\\repo\\src', win32)).toBe(true);
    expect(isPathWithin('\\\\server\\share\\repo', '\\\\server\\share2\\repo', win32)).toBe(false);
  });
});
