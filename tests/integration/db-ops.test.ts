import { describe, it, expect } from 'vitest';
import {
  isReadOnlyQuery,
  maskRow,
  DbManager,
} from '../../src/managers/db-manager.js';

/**
 * Q8 - database integration tests.
 *
 * The DB drivers (`better-sqlite3` / `pg`) are optional peer deps. The pure
 * guard logic (read-only classification + secret-column masking) is always
 * tested. The driver-backed end-to-end flow runs only when `better-sqlite3`
 * is installed, so this suite stays green in a minimal install and gives real
 * coverage when the optional driver is present.
 */

describe('db read-only query guard (Q8)', () => {
  it('accepts SELECT / WITH / EXPLAIN / PRAGMA', () => {
    expect(isReadOnlyQuery('SELECT * FROM users')).toBe(true);
    expect(isReadOnlyQuery('  with t as (select 1) select * from t')).toBe(true);
    expect(isReadOnlyQuery('EXPLAIN SELECT 1')).toBe(true);
    expect(isReadOnlyQuery('PRAGMA table_info(users)')).toBe(true);
  });

  it('rejects writes and DDL', () => {
    expect(isReadOnlyQuery('INSERT INTO users VALUES (1)')).toBe(false);
    expect(isReadOnlyQuery('UPDATE users SET name = 1')).toBe(false);
    expect(isReadOnlyQuery('DELETE FROM users')).toBe(false);
    expect(isReadOnlyQuery('DROP TABLE users')).toBe(false);
    expect(isReadOnlyQuery('CREATE TABLE t (id int)')).toBe(false);
  });

  it('rejects a write hidden behind a trailing semicolon', () => {
    expect(isReadOnlyQuery('DELETE FROM users;')).toBe(false);
  });
});

describe('db secret-column masking (Q8)', () => {
  it('masks password / secret / token / api_key columns', () => {
    const masked = maskRow({
      id: 1,
      email: 'a@b.com',
      password: 'hunter2',
      api_key: 'sk-123',
      session_token: 'abc',
      name: 'Alice',
    });
    expect(masked.id).toBe(1);
    expect(masked.email).toBe('a@b.com');
    expect(masked.name).toBe('Alice');
    expect(masked.password).toBe('[MASKED]');
    expect(masked.api_key).toBe('[MASKED]');
    expect(masked.session_token).toBe('[MASKED]');
  });
});

describe('db manager driver-backed flow (Q8, sqlite optional)', () => {
  it('connects, lists tables, and runs a masked read-only query', async () => {
    let Database: unknown;
    try {
      Database = (await import('better-sqlite3')).default;
    } catch {
      // Optional driver not installed - skip the driver-backed assertions.
      // (The guard + masking suites above still cover the security logic.)
      expect(true).toBe(true);
      return;
    }

    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ff-db-'));
    const file = join(dir, 'dev.sqlite');

    // Seed a tiny database directly with the driver.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seed = new (Database as any)(file);
    seed.exec(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, password TEXT);'
    );
    seed.prepare('INSERT INTO users (name, password) VALUES (?, ?)').run('Alice', 'hunter2');
    seed.close();

    const db = new DbManager();
    await db.connect('dev', 'sqlite', file);

    const tables = await db.listTables('dev');
    expect(tables).toContain('users');

    const rows = await db.queryReadonly('dev', 'SELECT id, name, password FROM users');
    expect(rows[0].name).toBe('Alice');
    expect(rows[0].password).toBe('[MASKED]');

    await expect(db.queryReadonly('dev', 'DELETE FROM users')).rejects.toThrow(/read-only/i);
  });

  it('refuses a production-looking target', async () => {
    const db = new DbManager();
    await expect(
      db.connect('p', 'sqlite', '/var/data/production.sqlite')
    ).rejects.toThrow(/production/i);
  });
});
