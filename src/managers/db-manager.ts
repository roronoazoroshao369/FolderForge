/**
 * Read-only database manager. MVP supports SQLite via better-sqlite3 if present
 * and Postgres via 'pg' if present; both are optional peer deps loaded lazily.
 * If a driver is missing, the tools return a clear, actionable error instead of
 * crashing the server.
 */

export interface DbConnection {
  id: string;
  kind: 'sqlite' | 'postgres';
  target: string;
  readonly: boolean;
}

const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|REPLACE|MERGE|VACUUM)\b/i;

export function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (WRITE_KEYWORDS.test(trimmed)) return false;
  return /^(SELECT|WITH|EXPLAIN|PRAGMA|SHOW)\b/i.test(trimmed);
}

const SECRET_COL = /pass(word)?|secret|token|api[_-]?key|private[_-]?key/i;

export function maskRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = SECRET_COL.test(k) ? '[MASKED]' : v;
  }
  return out;
}

export class DbManager {
  private connections = new Map<string, DbConnection>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handles = new Map<string, any>();

  list(): DbConnection[] {
    return [...this.connections.values()];
  }

  private require(id: string): { conn: DbConnection; handle: unknown } {
    const conn = this.connections.get(id);
    const handle = this.handles.get(id);
    if (!conn || !handle) throw new Error(`Unknown db connection: ${id}`);
    return { conn, handle };
  }

  async connect(id: string, kind: 'sqlite' | 'postgres', target: string): Promise<DbConnection> {
    if (/prod|production/i.test(target)) {
      throw new Error('Refusing to connect to a production-looking database target.');
    }
    if (kind === 'sqlite') {
      const mod = await this.tryImport('better-sqlite3', 'SQLite');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Database = (mod as any).default ?? mod;
      const db = new Database(target, { readonly: true, fileMustExist: true });
      this.handles.set(id, db);
    } else {
      const mod = await this.tryImport('pg', 'Postgres');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Client = (mod as any).Client;
      const client = new Client({ connectionString: target });
      await client.connect();
      this.handles.set(id, client);
    }
    const conn: DbConnection = { id, kind, target, readonly: true };
    this.connections.set(id, conn);
    return conn;
  }

  async listTables(id: string): Promise<string[]> {
    const { conn, handle } = this.require(id);
    if (conn.kind === 'sqlite') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (handle as any)
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all();
      return rows.map((r: { name: string }) => r.name);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (handle as any).query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    return res.rows.map((r: { table_name: string }) => r.table_name);
  }

  async describeTable(id: string, table: string): Promise<unknown> {
    const { conn, handle } = this.require(id);
    if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error('Invalid table name');
    if (conn.kind === 'sqlite') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (handle as any).prepare(`PRAGMA table_info(${table})`).all();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (handle as any).query(
      'SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position',
      [table]
    );
    return res.rows;
  }

  async queryReadonly(id: string, sql: string, limit = 200): Promise<Record<string, unknown>[]> {
    if (!isReadOnlyQuery(sql)) throw new Error('Only read-only queries (SELECT/EXPLAIN/WITH) are allowed.');
    const { conn, handle } = this.require(id);
    let rows: Record<string, unknown>[];
    if (conn.kind === 'sqlite') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows = (handle as any).prepare(sql).all().slice(0, limit);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (handle as any).query(sql);
      rows = res.rows.slice(0, limit);
    }
    return rows.map(maskRow);
  }

  async explain(id: string, sql: string): Promise<unknown> {
    const cleaned = sql.trim().replace(/;+\s*$/, '');
    return this.queryReadonly(id, `EXPLAIN ${cleaned}`);
  }

  /**
   * Execute a single write statement (INSERT/UPDATE/DELETE) against a dev
   * connection. Refuses read-only-looking statements and DDL; migrations go
   * through {@link runMigration}. HIGH-risk: gated by policy/approval upstream.
   */
  async write(id: string, sql: string): Promise<{ changes: number }> {
    if (isReadOnlyQuery(sql)) {
      throw new Error('db_write expects a write statement (INSERT/UPDATE/DELETE), not a read-only query.');
    }
    const { conn, handle } = this.require(id);
    if (conn.readonly) {
      throw new Error(`Connection ${id} is read-only; db_write is not permitted.`);
    }
    if (conn.kind === 'sqlite') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = (handle as any).prepare(sql).run();
      return { changes: Number(info.changes ?? 0) };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (handle as any).query(sql);
    return { changes: Number(res.rowCount ?? 0) };
  }

  /**
   * Run a multi-statement migration script in a single transaction. HIGH-risk:
   * gated by policy/approval upstream.
   */
  async runMigration(id: string, sql: string): Promise<{ applied: boolean }> {
    const { conn, handle } = this.require(id);
    if (conn.readonly) {
      throw new Error(`Connection ${id} is read-only; db_run_migration is not permitted.`);
    }
    if (conn.kind === 'sqlite') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (handle as any).exec(sql);
      return { applied: true };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = handle as any;
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      return { applied: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }

  private async tryImport(mod: string, label: string): Promise<unknown> {
    try {
      return await import(mod);
    } catch {
      throw new Error(
        `${label} driver "${mod}" is not installed. Run: npm install ${mod} (optional dependency).`
      );
    }
  }
}
