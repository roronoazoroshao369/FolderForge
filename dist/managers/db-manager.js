/**
 * Read-only database manager. MVP supports SQLite via better-sqlite3 if present
 * and Postgres via 'pg' if present; both are optional peer deps loaded lazily.
 * If a driver is missing, the tools return a clear, actionable error instead of
 * crashing the server.
 */
const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|REPLACE|MERGE|VACUUM)\b/i;
export function isReadOnlyQuery(sql) {
    const trimmed = sql.trim().replace(/;+\s*$/, '');
    if (WRITE_KEYWORDS.test(trimmed))
        return false;
    return /^(SELECT|WITH|EXPLAIN|PRAGMA|SHOW)\b/i.test(trimmed);
}
const SECRET_COL = /pass(word)?|secret|token|api[_-]?key|private[_-]?key/i;
export function maskRow(row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
        out[k] = SECRET_COL.test(k) ? '[MASKED]' : v;
    }
    return out;
}
export class DbManager {
    connections = new Map();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handles = new Map();
    list() {
        return [...this.connections.values()];
    }
    require(id) {
        const conn = this.connections.get(id);
        const handle = this.handles.get(id);
        if (!conn || !handle)
            throw new Error(`Unknown db connection: ${id}`);
        return { conn, handle };
    }
    async connect(id, kind, target) {
        if (/prod|production/i.test(target)) {
            throw new Error('Refusing to connect to a production-looking database target.');
        }
        if (kind === 'sqlite') {
            const mod = await this.tryImport('better-sqlite3', 'SQLite');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const Database = mod.default ?? mod;
            const db = new Database(target, { readonly: true, fileMustExist: true });
            this.handles.set(id, db);
        }
        else {
            const mod = await this.tryImport('pg', 'Postgres');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const Client = mod.Client;
            const client = new Client({ connectionString: target });
            await client.connect();
            this.handles.set(id, client);
        }
        const conn = { id, kind, target, readonly: true };
        this.connections.set(id, conn);
        return conn;
    }
    async listTables(id) {
        const { conn, handle } = this.require(id);
        if (conn.kind === 'sqlite') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rows = handle
                .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .all();
            return rows.map((r) => r.name);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await handle.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
        return res.rows.map((r) => r.table_name);
    }
    async describeTable(id, table) {
        const { conn, handle } = this.require(id);
        if (!/^[A-Za-z0-9_]+$/.test(table))
            throw new Error('Invalid table name');
        if (conn.kind === 'sqlite') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return handle.prepare(`PRAGMA table_info(${table})`).all();
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await handle.query('SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position', [table]);
        return res.rows;
    }
    async queryReadonly(id, sql, limit = 200) {
        if (!isReadOnlyQuery(sql))
            throw new Error('Only read-only queries (SELECT/EXPLAIN/WITH) are allowed.');
        const { conn, handle } = this.require(id);
        let rows;
        if (conn.kind === 'sqlite') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rows = handle.prepare(sql).all().slice(0, limit);
        }
        else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const res = await handle.query(sql);
            rows = res.rows.slice(0, limit);
        }
        return rows.map(maskRow);
    }
    async explain(id, sql) {
        const cleaned = sql.trim().replace(/;+\s*$/, '');
        return this.queryReadonly(id, `EXPLAIN ${cleaned}`);
    }
    async tryImport(mod, label) {
        try {
            return await import(mod);
        }
        catch {
            throw new Error(`${label} driver "${mod}" is not installed. Run: npm install ${mod} (optional dependency).`);
        }
    }
}
