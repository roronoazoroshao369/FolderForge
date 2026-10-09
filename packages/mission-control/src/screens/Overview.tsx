import { useState } from 'react';
import { Boxes, FolderGit2, ListChecks, Share2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAction, useApi } from '../hooks';
import {
  Button,
  Card,
  Code,
  DataTable,
  EmptyState,
  ErrorNote,
  PageHeader,
  SkeletonRows,
  Stat,
  StatePill,
  useToast,
} from '../ui';
import type { ApprovalRecord, FleetInstance, StatusSnapshot, TunnelRecord } from '../types';

interface ManagedIsolation {
  id: string;
  taskId: string;
  branch: string;
  state: string;
  worktreeRoot: string;
  observedHealth?: string;
  observedAt?: string;
}

interface MissionControlSnapshot {
  isolations?: ManagedIsolation[];
}

export function OverviewScreen() {
  const mission = useApi<MissionControlSnapshot>('/mission-control');
  const discard = useAction();
  const toast = useToast();
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null);
  const status = useApi<StatusSnapshot>('/status');
  const fleet = useApi<{ instances: FleetInstance[] }>('/fleet');
  const tunnels = useApi<{ tunnels: TunnelRecord[] }>('/tunnels');
  const approvals = useApi<{ pending?: ApprovalRecord[] }>('/approvals');
  const instances = fleet.data?.instances ?? [];
  const running = instances.filter((i) => i.state === 'running').length;
  const liveTunnels = (tunnels.data?.tunnels ?? []).filter((t) => t.state === 'running').length;
  const pending = approvals.data?.pending?.length ?? 0;
  const firstLoad = fleet.loading && tunnels.loading && approvals.loading && status.loading;

  return (
    <div className="grid gap-6">
      <PageHeader title="Overview" subtitle="Live control-plane snapshot, refreshed every 5 seconds." />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="instances running" value={running} icon={<Boxes size={17} />} tone={running > 0 ? 'good' : 'default'} />
        <Stat label="folders provisioned" value={instances.length} icon={<FolderGit2 size={17} />} />
        <Stat label="public tunnels" value={liveTunnels} icon={<Share2 size={17} />} tone={liveTunnels > 0 ? 'warn' : 'default'} />
        <Stat label="pending approvals" value={pending} icon={<ListChecks size={17} />} tone={pending > 0 ? 'warn' : 'default'} />
      </div>

      {pending > 0 ? (
        <Card className="border-[#6b571d] bg-[#30270d]/40">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[13px] text-warn">
              {pending} approval request{pending > 1 ? 's' : ''} waiting for your decision.
            </div>
            <Link
              to="/approvals"
              className="inline-flex items-center rounded-lg border border-[#6b571d] px-3 py-1.5 text-xs font-medium text-warn hover:bg-[#403410]/50 transition-colors"
            >
              Review approvals
            </Link>
          </div>
        </Card>
      ) : null}

      <Card title="Managed task isolations" hint="local worktrees · not GitHub remote branches">
        <ErrorNote message={mission.error ?? discard.error} />
        {(mission.data?.isolations ?? []).length === 0 ? (
          <p className="text-sm text-muted">No managed task isolations.</p>
        ) : (
          <div className="grid gap-3">
            {(mission.data?.isolations ?? []).map((isolation) => {
              const healthy = isolation.observedHealth === 'present_consistent';
              const eligible = healthy && (isolation.state === 'active' || isolation.state === 'rolled_back');
              const healthLabel: Record<string, string> = {
                present_consistent: 'Available',
                missing_worktree: 'Worktree missing',
                identity_mismatch: 'Identity mismatch',
                unverifiable: 'Unable to verify',
                terminal_record: 'Not available',
              };
              const confirming = confirmDiscardId === isolation.id;
              return (
                <div key={isolation.id} className="grid gap-2 rounded-lg border border-border p-3 sm:flex sm:items-center sm:justify-between">
                  <div className="grid gap-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Code>{isolation.taskId}</Code>
                      <StatePill value={isolation.state} />
                    </div>
                    <Code className="break-all">{isolation.branch}</Code>
                    <p className="text-xs text-muted break-all">Worktree: {isolation.worktreeRoot}</p>
                    <p className={healthy ? 'text-xs text-muted' : 'text-xs text-warn'} role="status">Health: {healthLabel[isolation.observedHealth ?? ''] ?? 'Health unavailable'}</p>
                    {confirming ? (
                      <p className="text-xs text-danger">
                        Discard permanently removes this local worktree and local task branch,
                        including uncommitted changes. Back up any needed files first.
                        Remote GitHub branches are unaffected.
                      </p>
                    ) : null}
                  </div>
                  {eligible ? (
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {confirming ? (
                        <>
                          <Button variant="danger" size="sm" busy={discard.busy} disabled={discard.busy}
                            onClick={() => void discard.run(
                              `/isolations/${encodeURIComponent(isolation.id)}/discard`,
                            ).then((ok) => {
                              if (!ok) return;
                              setConfirmDiscardId(null);
                              mission.reload();
                              toast('success', 'Local isolation discarded');
                            })}>
                            Confirm discard
                          </Button>
                          <Button size="sm" variant="ghost" disabled={discard.busy}
                            onClick={() => setConfirmDiscardId(null)}>Cancel</Button>
                        </>
                      ) : (
                        <Button size="sm" variant="danger" disabled={discard.busy}
                          onClick={() => setConfirmDiscardId(isolation.id)}>Discard…</Button>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Control plane" hint="live">
          <div className="grid">
            <div className="flex items-center justify-between gap-4 py-1.5 border-b border-border-soft text-[13px]">
              <span className="text-muted">Policy mode</span>
              <Code>{status.data?.policy?.mode ?? '—'}</Code>
            </div>
            <div className="flex items-center justify-between gap-4 py-1.5 border-b border-border-soft text-[13px]">
              <span className="text-muted shrink-0">Workspace</span>
              <Code className="truncate">{status.data?.workspace?.projectRoot ?? '—'}</Code>
            </div>
            <div className="flex items-center justify-between gap-4 py-1.5 text-[13px]">
              <span className="text-muted">Version</span>
              <Code>{status.data?.server?.version ?? '—'}</Code>
            </div>
          </div>
          <ErrorNote message={status.error} />
        </Card>
        <Card title="Fleet quick view" hint="per-folder MCP servers">
          {firstLoad ? (
            <SkeletonRows rows={3} />
          ) : (
            <DataTable
              head={['Instance', 'Port', 'State']}
              rows={instances.map((i) => [
                <Code key="id">{i.id}</Code>,
                <Code key="p">{i.port}</Code>,
                <StatePill key="s" value={i.state} />,
              ])}
              empty={
                <EmptyState
                  icon={<Boxes size={22} />}
                  title="No instances yet"
                  hint="Provision a folder from the Fleet screen to give it its own governed MCP server."
                />
              }
            />
          )}
        </Card>
      </div>
    </div>
  );
}
