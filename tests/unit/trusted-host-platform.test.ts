import { describe, expect, it } from 'vitest';
import {
  checkLocalTerminal,
  detectConsentPlatform,
  requireSupportedLocalPlatform,
} from '../../src/operator/trusted-host-platform.js';

describe('host operator consent platform boundary', () => {
  it('distinguishes macOS, Linux and unsupported platforms', () => {
    expect(detectConsentPlatform('darwin')).toBe('darwin');
    expect(detectConsentPlatform('linux')).toBe('linux');
    expect(detectConsentPlatform('win32')).toBe('unsupported');
    expect(detectConsentPlatform('freebsd')).toBe('unsupported');
  });

  it('fails closed on unsupported platforms', () => {
    expect(() => requireSupportedLocalPlatform('win32')).toThrow('LOCAL_CONFIRMATION_UNAVAILABLE');
    expect(() => requireSupportedLocalPlatform('unknown')).toThrow('LOCAL_CONFIRMATION_UNAVAILABLE');
    expect(() => requireSupportedLocalPlatform('darwin')).not.toThrow();
  });

  it('requires both interactive input and output, never silently grants over a pipe', () => {
    expect(() => checkLocalTerminal({ stdinIsTTY: false, stdoutIsTTY: true })).toThrow('LOCAL_TERMINAL_REQUIRED');
    expect(() => checkLocalTerminal({ stdinIsTTY: true, stdoutIsTTY: false })).toThrow('LOCAL_TERMINAL_REQUIRED');
    expect(() => checkLocalTerminal({ stdinIsTTY: true, stdoutIsTTY: true })).not.toThrow();
  });
});
