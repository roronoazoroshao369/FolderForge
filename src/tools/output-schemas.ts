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

/** Output of shell_exec on success or non-zero exit. */
export const SHELL_EXEC_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    exitCode: { type: ['integer', 'null'] },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    durationMs: { type: 'integer' },
    risk: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
  },
  required: ['exitCode', 'stdout', 'stderr', 'durationMs', 'risk'],
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

/** Output of project_analyze. */
export const PROJECT_ANALYZE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    version: { type: ['string', 'null'] },
    private: { type: ['boolean', 'null'] },
    projectRoot: { type: 'string' },
    languages: { type: 'array', items: { type: 'string' } },
    packageManagers: { type: 'array', items: { type: 'string' } },
    frameworks: { type: 'array', items: { type: 'string' } },
    commands: { type: 'object', additionalProperties: true },
    architecture: { type: 'object', additionalProperties: true },
    manifests: { type: 'array', items: { type: 'string' } },
    configFiles: { type: 'array', items: { type: 'string' } },
    git: { type: 'object', additionalProperties: true },
  },
  required: ['name', 'projectRoot', 'languages', 'packageManagers', 'frameworks', 'commands', 'architecture', 'manifests', 'configFiles', 'git'],
} as const;

/** Output of code_context. */
export const CODE_CONTEXT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    scannedFiles: { type: 'integer' },
    indexedFiles: { type: 'integer' },
    indexedBytes: { type: 'integer' },
    truncated: { type: 'boolean' },
    skippedLarge: { type: 'integer' },
    skippedDenied: { type: 'integer' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          kind: { type: 'string' },
          score: { type: 'number' },
          size: { type: 'integer' },
          snippets: { type: 'array', items: { type: 'string' } },
          relatedTests: { type: 'array', items: { type: 'string' } },
        },
        required: ['path', 'kind', 'score', 'size', 'snippets', 'relatedTests'],
      },
    },
    matchingTests: { type: 'array', items: { type: 'string' } },
    hints: { type: 'object', additionalProperties: true },
  },
  required: ['query', 'scannedFiles', 'indexedFiles', 'indexedBytes', 'truncated', 'results', 'matchingTests'],
} as const;

const patchFileView = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    existed: { type: 'boolean' },
    beforeBytes: { type: 'integer' },
    afterBytes: { type: 'integer' },
    diff: { type: 'string' },
  },
  required: ['path', 'existed', 'beforeBytes', 'afterBytes', 'diff'],
} as const;

/** Output of patch_transaction. */
export const PATCH_TRANSACTION_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    projectRoot: { type: 'string' },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer' },
    state: { type: 'string', enum: ['previewed', 'applied', 'rolled_back'] },
    files: { type: 'array', items: patchFileView },
  },
  required: ['id', 'projectRoot', 'createdAt', 'updatedAt', 'state', 'files'],
} as const;

/** Output of project_verify for plan/run/status/list actions. */
export const PROJECT_VERIFY_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    dryRun: { type: 'boolean' },
    action: { type: 'string' },
    id: { type: 'string' },
    state: { type: 'string', enum: ['running', 'completed', 'cancelled', 'interrupted'] },
    overall: { type: 'string', enum: ['passed', 'failed', 'unavailable', 'incomplete'] },
    passed: { type: 'boolean' },
    packageManager: { type: ['string', 'null'] },
    requested: { type: 'array', items: { type: 'string' } },
    completed: { type: 'integer' },
    counts: { type: 'object', additionalProperties: { type: 'integer' } },
    plan: { type: 'array', items: { type: 'object', additionalProperties: true } },
    runs: { type: 'array', items: { type: 'object', additionalProperties: true } },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          check: { type: 'string' },
          command: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['pending', 'passed', 'failed', 'skipped', 'unavailable'] },
          exitCode: { type: ['integer', 'null'] },
          durationMs: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          errors: { type: 'array', items: errorItem },
          passed: { type: 'boolean' },
          skipped: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['check', 'command', 'status'],
      },
    },
  },
} as const;

/** Output of change_summary. */
export const CHANGE_SUMMARY_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: ['string', 'null'] },
    clean: { type: 'boolean' },
    ahead: { type: 'integer' },
    behind: { type: 'integer' },
    files: { type: 'object', additionalProperties: true },
    numstat: { type: 'object', additionalProperties: true },
    suggestedChecks: { type: 'array', items: { type: 'string' } },
    commitReady: { type: 'boolean' },
  },
  required: ['clean', 'files', 'numstat', 'suggestedChecks', 'commitReady'],
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
