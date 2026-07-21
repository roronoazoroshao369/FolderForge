/**
 * Structured error types for FolderForge.
 */

export class FolderForgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FolderForgeError';
    this.code = code;
  }
}

export class PolicyDeniedError extends FolderForgeError {
  constructor(message: string) {
    super('POLICY_DENIED', message);
    this.name = 'PolicyDeniedError';
  }
}

export class ApprovalRequiredError extends FolderForgeError {
  approvalId: string;
  constructor(message: string, approvalId: string) {
    super('APPROVAL_REQUIRED', message);
    this.name = 'ApprovalRequiredError';
    this.approvalId = approvalId;
  }
}

export class PathEscapeError extends FolderForgeError {
  constructor(message: string) {
    super('PATH_ESCAPE', message);
    this.name = 'PathEscapeError';
  }
}

export class WorkspaceNotActiveError extends FolderForgeError {
  constructor() {
    super('NO_WORKSPACE', 'No active workspace. Call workspace_activate first.');
    this.name = 'WorkspaceNotActiveError';
  }
}

export class AuditUnavailableError extends FolderForgeError {
  constructor() {
    super(
      'AUDIT_UNAVAILABLE',
      'Required audit storage is unavailable. Check free space, permissions, and JSONL integrity for .folderforge/audit.',
    );
    this.name = 'AuditUnavailableError';
  }
}
