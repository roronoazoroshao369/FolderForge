import { ListChecks } from 'lucide-react';
import { useAction, useApi } from '../hooks';
import {
  Button,
  Card,
  Code,
  DataTable,
  EmptyState,
  ErrorNote,
  PageHeader,
  RiskBadge,
  SkeletonRows,
  StatePill,
  useToast,
} from '../ui';
import type { ApprovalRecord } from '../types';

export function ApprovalsScreen() {
  const toast = useToast();
  const approvals = useApi<{ pending?: ApprovalRecord[]; approvals?: ApprovalRecord[] }>('/approvals');
  const action = useAction();
  const list = approvals.data?.pending ?? approvals.data?.approvals ?? [];

  const decide = async (id: string, decision: 'approve' | 'deny') => {
    const ok = await action.run(
      `/approvals/${encodeURIComponent(id)}/${decision}`,
      decision === 'approve' ? { scope: 'once' } : undefined,
    );
    if (ok) {
      approvals.reload();
      toast('success', `Request ${decision}d`);
    }
  };

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Approvals"
        subtitle="HIGH/CRITICAL tools wait here when the policy requires a human decision."
      />
      <Card title="Approval requests" hint={list.length > 0 ? `${list.length} shown` : undefined}>
        {approvals.loading ? (
          <SkeletonRows rows={2} />
        ) : (
          <DataTable
            head={['Request', 'Tool', 'Risk', 'Status', 'Decision']}
            rows={list.map((a) => [
              <Code key="id" className="inline-block max-w-[200px] truncate align-middle">{a.id}</Code>,
              <Code key="t">{a.tool ?? a.toolName ?? '—'}</Code>,
              a.risk ? <RiskBadge key="r" risk={a.risk} /> : <span key="r" className="text-muted">—</span>,
              <StatePill key="s" value={a.status ?? 'pending'} />,
              a.status === undefined || a.status === 'pending' ? (
                <span key="a" className="inline-flex gap-1.5">
                  <Button size="sm" variant="primary" disabled={action.busy} onClick={() => void decide(a.id, 'approve')}>
                    Approve
                  </Button>
                  <Button size="sm" variant="danger" disabled={action.busy} onClick={() => void decide(a.id, 'deny')}>
                    Deny
                  </Button>
                </span>
              ) : (
                <span key="a" className="text-muted">—</span>
              ),
            ])}
            empty={
              <EmptyState
                icon={<ListChecks size={22} />}
                title="No pending approvals"
                hint="When an agent hits a HIGH/CRITICAL action under a gated policy, it lands here."
              />
            }
          />
        )}
        <ErrorNote message={action.error ?? approvals.error} />
      </Card>
    </div>
  );
}
