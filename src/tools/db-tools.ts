import { defineTool } from './registry.js';
import type { ToolDefinition } from '../core/types.js';
import { DB_QUERY_OUTPUT_SCHEMA } from './output-schemas.js';

export function dbTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'db_connect',
      description: 'Register a read-only dev database connection (sqlite or postgres). Production targets are refused.',
      group: 'db',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['sqlite', 'postgres'] },
          target: { type: 'string', description: 'SQLite file path or Postgres connection string.' },
        },
        required: ['id', 'kind', 'target'],
      },
      handler: async (args, ctx) => {
        try {
          const conn = await ctx.container.db.connect(
            String(args.id),
            args.kind as 'sqlite' | 'postgres',
            String(args.target)
          );
          return { ok: true, data: conn };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
    }),
    defineTool({
      name: 'db_list_connections',
      description: 'List registered database connections.',
      group: 'db',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      handler: async (_a, ctx) => ({ ok: true, data: { connections: ctx.container.db.list() } }),
    }),
    defineTool({
      name: 'db_list_tables',
      description: 'List tables in a connected database.',
      group: 'db',
      mutates: false,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async (args, ctx) => ({ ok: true, data: { tables: await ctx.container.db.listTables(String(args.id)) } }),
    }),
    defineTool({
      name: 'db_describe_table',
      description: 'Describe a table schema.',
      group: 'db',
      mutates: false,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, table: { type: 'string' } },
        required: ['id', 'table'],
      },
      handler: async (args, ctx) => ({
        ok: true,
        data: { schema: await ctx.container.db.describeTable(String(args.id), String(args.table)) },
      }),
    }),
    defineTool({
      name: 'db_query_readonly',
      description: 'Run a read-only query (SELECT/EXPLAIN/WITH). Write queries are rejected; secret columns masked.',
      group: 'db',
      mutates: false,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, sql: { type: 'string' }, limit: { type: 'number' } },
        required: ['id', 'sql'],
      },
      outputSchema: DB_QUERY_OUTPUT_SCHEMA,
      handler: async (args, ctx) => ({
        ok: true,
        data: { rows: await ctx.container.db.queryReadonly(String(args.id), String(args.sql), Number(args.limit ?? 200)) },
      }),
    }),
    defineTool({
      name: 'db_explain',
      description: 'Explain a query plan (read-only).',
      group: 'db',
      mutates: false,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, sql: { type: 'string' } },
        required: ['id', 'sql'],
      },
      handler: async (args, ctx) => ({
        ok: true,
        data: { plan: await ctx.container.db.explain(String(args.id), String(args.sql)) },
      }),
    }),
    defineTool({
      name: 'db_write',
      description: 'Execute a single write statement (INSERT/UPDATE/DELETE) on a dev connection. HIGH risk; requires approval.',
      group: 'db',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, sql: { type: 'string' } },
        required: ['id', 'sql'],
      },
      handler: async (args, ctx) => {
        try {
          return { ok: true, data: await ctx.container.db.write(String(args.id), String(args.sql)) };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
    }),
    defineTool({
      name: 'db_run_migration',
      description: 'Run a migration script in a single transaction on a dev connection. HIGH risk; requires approval.',
      group: 'db',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, sql: { type: 'string' } },
        required: ['id', 'sql'],
      },
      handler: async (args, ctx) => {
        try {
          return { ok: true, data: await ctx.container.db.runMigration(String(args.id), String(args.sql)) };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
    }),
  ];
}
