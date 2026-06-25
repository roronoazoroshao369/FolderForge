/**
 * Reusable JSON-Schema fragments for tool `outputSchema` declarations
 * (roadmap Q1 - typed structured output). These describe the shape of the
 * `data` payload a tool returns on success so MCP clients can validate the
 * `structuredContent` field advertised by the server.
 *
 * Keeping them centralized means the schema and the handler stay close and a
 * single source documents the structured contract for the four "high-value"
 * tools called out in the roadmap: run_test, code_diagnostics, git_status,
 * db_query_readonly.
 */

const errorItem = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    line: { type: 'integer' },
    column: { type: 'integer' },
    severity: { type: 'string', enum: ['error', 'warning', 'info'] },
    message: { type: 'string' },
    code: { type: 'string' },
  },
} as const;

/** Output of run_test / run_lint / run_typecheck / run_build (runScript). */
export const RUN_SCRIPT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The resolved command that was executed.' },
    exitCode: { type: ['integer', 'null'], description: 'Process exit code (0 = success).' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    errors: {
      type: 'array',
      description: 'Structured failures parsed from the output.',
      items: errorItem,
    },
  },
  required: ['command', 'exitCode', 'errors'],
} as const;

/** Output of code_diagnostics. */
export const DIAGNOSTICS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    diagnostics: { type: 'array', items: errorItem },
    count: { type: 'integer' },
    source: {
      type: 'string',
      description: 'Backend that produced the diagnostics (e.g. "lsp" or "regex").',
    },
  },
  required: ['diagnostics'],
} as const;

/** Output of git_status. */
export const GIT_STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: ['string', 'null'] },
    ahead: { type: 'integer' },
    behind: { type: 'integer' },
    clean: { type: 'boolean' },
    staged: { type: 'array', items: { type: 'string' } },
    modified: { type: 'array', items: { type: 'string' } },
    not_added: { type: 'array', items: { type: 'string' } },
    deleted: { type: 'array', items: { type: 'string' } },
    conflicted: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** Output of db_query_readonly. */
export const DB_QUERY_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      description: 'Result rows; each row is a column->value object.',
      items: { type: 'object', additionalProperties: true },
    },
  },
  required: ['rows'],
} as const;

/** Output of run_coverage. */
export const COVERAGE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    exitCode: { type: ['integer', 'null'] },
    summary: {
      type: ['object', 'null'],
      description: 'Coverage percentages (lines/branches/functions/statements).',
      properties: {
        lines: { type: 'number' },
        branches: { type: 'number' },
        functions: { type: 'number' },
        statements: { type: 'number' },
      },
    },
    errors: { type: 'array', items: errorItem },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
  },
  required: ['command', 'exitCode'],
} as const;
