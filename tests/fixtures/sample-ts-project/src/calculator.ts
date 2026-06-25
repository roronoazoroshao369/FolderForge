/**
 * Tiny calculator module used as a known-content target for FolderForge's
 * search and code tools in integration tests. The symbol names here are
 * referenced by assertions, so keep them stable.
 */

export interface Money {
  cents: number;
}

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export class Calculator {
  private total = 0;

  add(n: number): this {
    this.total = add(this.total, n);
    return this;
  }

  subtract(n: number): this {
    this.total = subtract(this.total, n);
    return this;
  }

  result(): number {
    return this.total;
  }
}

export const TAX_RATE = 0.08;
