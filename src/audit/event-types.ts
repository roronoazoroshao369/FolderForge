export type AuditEventType =
  | 'tool_call'
  | 'tool_result'
  | 'tool_error'
  | 'policy_deny'
  | 'policy_change'
  | 'rate_limited'
  | 'approval_request'
  | 'approval_resolved'
  | 'workspace_activate'
  | 'process_event'
  | 'server_start';

export interface AuditEvent {
  ts: string;
  type: AuditEventType;
  tool?: string;
  risk?: string;
  ok?: boolean;
  durationMs?: number;
  summary?: string;
  detail?: Record<string, unknown>;
}
