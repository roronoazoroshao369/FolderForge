import { useState } from 'react';
import { FolderGit2, FolderPlus } from 'lucide-react';
import { useAction, useApi } from '../hooks';
import {
  Button,
  Card,
  Code,
  DataTable,
  EmptyState,
  ErrorNote,
  Input,
  PageHeader,
  SkeletonRows,
  StatePill,
  useToast,
} from '../ui';
import type { WorkspaceRecord } from '../types';

export function WorkspacesScreen() {
  const toast = useToast();
  const ws = useApi<{ workspaces: WorkspaceRecord[] }>('/workspaces');
  const action = useAction();
  const [newPath, setNewPath] = useState('');

  const addFolder = async () => {
    const ok = await action.run('/workspaces/activate', { path: newPath.trim() });
    if (ok) {
      setNewPath('');
      ws.reload();
      toast('success', 'Folder activated as a workspace');
    }
  };

  const rows = (ws.data?.workspaces ?? []).map((w) => {
    const path = w.projectRoot ?? w.path ?? w.root ?? '';
    const current = Boolean(w.current ?? w.active ?? w.isCurrent);
    return [
      <Code key="p" className="inline-block max-w-[320px] truncate align-middle">{path}</Code>,
      <StatePill key="s" value={current ? 'current' : 'registered'} />,
      current ? (
        <span key="a" className="text-muted">—</span>
      ) : (
        <Button
          key="a"
          size="sm"
          variant="primary"
          disabled={action.busy}
          onClick={() =>
            void action.run('/workspaces/switch', { path }).then((ok) => {
              if (ok) {
                ws.reload();
                toast('success', `Switched to ${path}`);
              }
            })
          }
        >
          Switch
        </Button>
      ),
    ];
  });

  return (
    <div className="grid gap-6">
      <PageHeader title="Workspaces" subtitle="Activated folders — path-less tool calls run in the current one." />

      <Card title="Add a folder" hint="activate any folder as a governed workspace">
        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-60">
            <Input
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="/absolute/path/to/folder"
              aria-label="Folder path to activate"
            />
          </div>
          <Button variant="primary" disabled={!newPath.trim() || action.busy} busy={action.busy} onClick={() => void addFolder()}>
            <FolderPlus size={14} aria-hidden /> Add folder
          </Button>
        </div>
        <ErrorNote message={action.error} />
      </Card>

      <Card title="Activated workspaces" hint={`${rows.length} registered`}>
        {ws.loading ? (
          <SkeletonRows rows={2} />
        ) : (
          <DataTable
            head={['Workspace', 'Status', 'Action']}
            rows={rows}
            empty={
              <EmptyState
                icon={<FolderGit2 size={22} />}
                title="No workspaces registered"
                hint="Add a folder above to start governing it."
              />
            }
          />
        )}
        <ErrorNote message={ws.error} />
      </Card>
    </div>
  );
}
