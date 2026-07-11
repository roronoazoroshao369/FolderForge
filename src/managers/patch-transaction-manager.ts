import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export type PatchTransactionState = 'previewed' | 'applied' | 'rolled_back';

export interface PatchFileSnapshot {
  /** Workspace-relative path presented to callers. */
  path: string;
  /** Boundary-checked absolute path used internally. */
  absolutePath: string;
  existed: boolean;
  before: string;
  after: string;
  diff: string;
}

export interface PatchTransaction {
  id: string;
  projectRoot: string;
  createdAt: number;
  updatedAt: number;
  state: PatchTransactionState;
  files: PatchFileSnapshot[];
}

export interface PatchTransactionView {
  id: string;
  projectRoot: string;
  createdAt: number;
  updatedAt: number;
  state: PatchTransactionState;
  files: Array<{
    path: string;
    existed: boolean;
    beforeBytes: number;
    afterBytes: number;
    diff: string;
  }>;
}

const MAX_TRANSACTIONS = 50;
const TRANSACTION_TTL_MS = 60 * 60 * 1000;

/**
 * In-memory, bounded transaction store for atomic multi-file text patches.
 *
 * Transactions deliberately do not survive a FolderForge restart: their safety
 * checks depend on exact before/after snapshots and a stale persisted rollback
 * would be more dangerous than useful. Git remains the durable history layer.
 */
export class PatchTransactionManager {
  private transactions = new Map<string, PatchTransaction>();

  create(projectRoot: string, files: PatchFileSnapshot[]): PatchTransactionView {
    this.prune();
    const now = Date.now();
    const tx: PatchTransaction = {
      id: `patch_${randomUUID().slice(0, 12)}`,
      projectRoot,
      createdAt: now,
      updatedAt: now,
      state: 'previewed',
      files: files.map((file) => ({ ...file })),
    };
    this.transactions.set(tx.id, tx);
    this.trimOldest();
    return this.view(tx);
  }

  get(id: string): PatchTransactionView {
    return this.view(this.require(id));
  }

  apply(id: string, force = false): PatchTransactionView {
    const tx = this.require(id);
    if (tx.state !== 'previewed') {
      throw new Error(`Patch transaction ${id} is ${tx.state}; only previewed transactions can be applied.`);
    }

    this.assertCurrentMatches(tx, 'before', force);
    const changed: PatchFileSnapshot[] = [];
    try {
      for (const file of tx.files) {
        mkdirSync(dirname(file.absolutePath), { recursive: true });
        writeFileSync(file.absolutePath, file.after, 'utf8');
        changed.push(file);
      }
    } catch (error) {
      // Best-effort atomicity: restore every file already written before
      // surfacing the original error.
      for (const file of changed.reverse()) this.restoreBefore(file);
      throw new Error(`Patch transaction ${id} failed and was rolled back: ${String(error)}`);
    }

    tx.state = 'applied';
    tx.updatedAt = Date.now();
    return this.view(tx);
  }

  rollback(id: string, force = false): PatchTransactionView {
    const tx = this.require(id);
    if (tx.state !== 'applied') {
      throw new Error(`Patch transaction ${id} is ${tx.state}; only applied transactions can be rolled back.`);
    }

    this.assertCurrentMatches(tx, 'after', force);
    const restored: PatchFileSnapshot[] = [];
    try {
      for (const file of tx.files) {
        this.restoreBefore(file);
        restored.push(file);
      }
    } catch (error) {
      // If rollback itself fails, restore the applied state for files already
      // touched so the transaction does not leave a half-rolled-back workspace.
      for (const file of restored.reverse()) {
        mkdirSync(dirname(file.absolutePath), { recursive: true });
        writeFileSync(file.absolutePath, file.after, 'utf8');
      }
      throw new Error(`Rollback of patch transaction ${id} failed: ${String(error)}`);
    }

    tx.state = 'rolled_back';
    tx.updatedAt = Date.now();
    return this.view(tx);
  }

  private assertCurrentMatches(
    tx: PatchTransaction,
    expected: 'before' | 'after',
    force: boolean
  ): void {
    if (force) return;
    const conflicts: string[] = [];
    for (const file of tx.files) {
      const exists = existsSync(file.absolutePath);
      const current = exists ? readFileSync(file.absolutePath, 'utf8') : null;
      const expectedExists = expected === 'before' ? file.existed : true;
      const expectedText = expected === 'before' ? file.before : file.after;
      if (exists !== expectedExists || (exists && current !== expectedText)) {
        conflicts.push(file.path);
      }
    }
    if (conflicts.length > 0) {
      throw new Error(
        `Patch transaction ${tx.id} conflicts with newer workspace changes: ${conflicts.join(', ')}. ` +
          'Review the files and create a new preview, or pass force=true only when overwriting is intentional.'
      );
    }
  }

  private restoreBefore(file: PatchFileSnapshot): void {
    if (!file.existed) {
      if (existsSync(file.absolutePath)) rmSync(file.absolutePath, { force: true });
      return;
    }
    mkdirSync(dirname(file.absolutePath), { recursive: true });
    writeFileSync(file.absolutePath, file.before, 'utf8');
  }

  private require(id: string): PatchTransaction {
    this.prune();
    const tx = this.transactions.get(id);
    if (!tx) throw new Error(`Unknown or expired patch transaction: ${id}`);
    return tx;
  }

  private view(tx: PatchTransaction): PatchTransactionView {
    return {
      id: tx.id,
      projectRoot: tx.projectRoot,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
      state: tx.state,
      files: tx.files.map((file) => ({
        path: file.path,
        existed: file.existed,
        beforeBytes: Buffer.byteLength(file.before),
        afterBytes: Buffer.byteLength(file.after),
        diff: file.diff,
      })),
    };
  }

  private prune(): void {
    const cutoff = Date.now() - TRANSACTION_TTL_MS;
    for (const [id, tx] of this.transactions) {
      if (tx.updatedAt < cutoff) this.transactions.delete(id);
    }
  }

  private trimOldest(): void {
    if (this.transactions.size <= MAX_TRANSACTIONS) return;
    const ordered = [...this.transactions.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const tx of ordered.slice(0, this.transactions.size - MAX_TRANSACTIONS)) {
      this.transactions.delete(tx.id);
    }
  }
}
