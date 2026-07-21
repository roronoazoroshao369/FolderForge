import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { RecordStore, SnapshotStore } from './ports.js';

export type RecordValidator<T> = (value: unknown, location: string) => T;

export class FileSnapshotStore<T extends { id: string }> implements SnapshotStore<T> {
  constructor(
    readonly filePath: string,
    private readonly validate: RecordValidator<T>,
  ) {}

  load(): T[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf8');
    if (raw.length > 0 && !raw.endsWith('\n')) {
      throw new Error(`${this.filePath} ends with an incomplete JSONL record.`);
    }
    const records: T[] = [];
    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `${this.filePath}:${index + 1} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      records.push(this.validate(parsed, `${this.filePath}:${index + 1}`));
    }
    return records;
  }

  append(record: T): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    appendDurable(this.filePath, `${JSON.stringify(record)}\n`);
  }

  replaceAll(records: T[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const body = records.length > 0 ? `${records.map((item) => JSON.stringify(item)).join('\n')}\n` : '';
    atomicDurableWrite(this.filePath, body);
  }
}

export class FileRecordStore<T> implements RecordStore<T> {
  constructor(
    readonly directory: string,
    private readonly validate: RecordValidator<T>,
    private readonly extension = '.json',
  ) {}

  load(): T[] {
    if (!existsSync(this.directory)) return [];
    const records: T[] = [];
    for (const name of readdirSync(this.directory).sort()) {
      if (!name.endsWith(this.extension)) continue;
      const path = join(this.directory, name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        throw new Error(
          `${path} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      records.push(this.validate(parsed, path));
    }
    return records;
  }

  write(id: string, record: T): void {
    assertRecordId(id);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(this.directory, 0o700);
    atomicDurableWrite(join(this.directory, `${id}${this.extension}`), `${JSON.stringify(record, null, 2)}\n`);
  }

  delete(id: string): void {
    assertRecordId(id);
    try {
      unlinkSync(join(this.directory, `${id}${this.extension}`));
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }
}

function appendDurable(path: string, content: string): void {
  const data = Buffer.from(content, 'utf8');
  let fd: number | undefined;
  try {
    fd = openSync(path, 'a', 0o600);
    writeAll(fd, data);
    fsyncSync(fd);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicDurableWrite(path: string, content: string): void {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const data = Buffer.from(content, 'utf8');
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeAll(fd, data);
    fsyncSync(fd);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Preserve the write failure.
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  renameSync(temp, path);
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written <= 0) throw new Error('Persistent store write made no forward progress.');
    offset += written;
  }
}

function assertRecordId(id: string): void {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(id)) {
    throw new Error(`Invalid persistent record id: ${id}`);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === code,
  );
}
