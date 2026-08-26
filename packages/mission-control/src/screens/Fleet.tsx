import { useState } from 'react';
import { Boxes, Copy } from 'lucide-react';
import { api } from '../api';
import { useAction, useApi } from '../hooks';
import {
  Banner,
  Button,
  Card,
  Code,
  DataTable,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  StatePill,
  useToast,
} from '../ui';
import type { FleetInstance } from '../types';

const PRESETS = ['vibe', 'vibe-lite', 'readonly', 'full', 'godot'];
const POLICIES = ['readonly', 'safe', 'dev', 'danger'];

export function FleetScreen() {
  const toast = useToast();
  const fleet = useApi<{ instances: FleetInstance[] }>('/fleet');
  const action = useAction();
  const [path, setPath] = useState('');
  const [preset, setPreset] = useState('vibe');
  const [policy, setPolicy] = useState('dev');
  const [issued, setIssued] = useState<{ id: string; token: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const provision = async () => {
    setFormError(null);
    try {
      const result = await api<{
        ok?: boolean;
        data?: { id?: string; token?: string };
        error?: string;
      }>('/fleet', {
        method: 'POST',
        body: { projectPath: path.trim(), toolsPreset: preset, policyMode: policy },
      });
      if (result.ok && result.data?.id && result.data.token) {
        setIssued({ id: result.data.id, token: result.data.token });
        setPath('');
        fleet.reload();
        toast('success', `Provisioned ${result.data.id}`);
      } else {
        setFormError(result.error ?? 'Provision failed.');
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  const lifecycle = async (id: string, actionName: string, body?: unknown, label?: string) => {
    const ok = await action.run(`/fleet/${encodeURIComponent(id)}/${actionName}`, body);
    if (ok) {
      fleet.reload();
      if (label) toast('success', label);
    }
  };

  const instances = fleet.data?.instances ?? [];
  return (
    <div className="grid gap-6">
      <PageHeader title="Fleet" subtitle="One governed MCP server per folder — provisioned, supervised, and token-secured." />

      <Card title="Provision a folder">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_170px_150px_auto] md:items-end">
          <Field label="Folder path">
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/absolute/path/to/folder"
              aria-label="Folder path to provision"
            />
          </Field>
          <Field label="Tool preset">
            <Select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Tool preset">
              {PRESETS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </Select>
          </Field>
          <Field label="Policy mode">
            <Select value={policy} onChange={(e) => setPolicy(e.target.value)} aria-label="Policy mode">
              {POLICIES.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </Select>
          </Field>
          <Button variant="primary" disabled={!path.trim() || action.busy} busy={action.busy} onClick={() => void provision()}>
            Provision
          </Button>
        </div>
        <ErrorNote message={formError ?? fleet.error} />
        {issued ? (
          <div className="mt-4">
            <Banner tone="info">
              <div className="grid gap-2">
                <div>
                  <strong>{issued.id}</strong> provisioned. Bearer token (shown exactly once):
                </div>
                <Code className="block rounded-lg bg-[#0b1119] px-2.5 py-2 text-warn break-all">{issued.token}</Code>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      navigator.clipboard
                        .writeText(issued.token)
                        .then(() => toast('success', 'Token copied to clipboard'))
                        .catch(() => undefined);
                    }}
                  >
                    <Copy size={13} aria-hidden /> Copy
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
                    Done
                  </Button>
                </div>
              </div>
            </Banner>
          </div>
        ) : null}
      </Card>

      <Card title="Instances" hint={`${instances.length} provisioned`}>
        {fleet.loading ? (
          <SkeletonRows rows={3} />
        ) : (
          <DataTable
            head={['Instance', 'Folder', 'Port', 'Preset', 'Policy', 'State', 'Auto-restart', 'Actions']}
            rows={instances.map((i) => [
              <Code key="id">{i.id}</Code>,
              <span key="f" className="inline-block max-w-[220px] truncate align-middle" title={i.projectPath}>
                {i.name}
              </span>,
              <Code key="p">{i.port}</Code>,
              <Select
                key="t"
                value={i.toolsPreset}
                aria-label={`Tool preset for ${i.id}`}
                disabled={action.busy}
                onChange={(e) =>
                  void lifecycle(i.id, 'preset', { toolsPreset: e.target.value }, `${i.id} → preset ${e.target.value} (restart to apply)`)
                }
              >
                {PRESETS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </Select>,
              <Code key="m">{i.policyMode}</Code>,
              <StatePill key="s" value={i.state} />,
              <Button
                key="ar"
                size="sm"
                variant={i.autoRestart ? 'primary' : 'ghost'}
                disabled={action.busy}
                title="Restart automatically after an unexpected exit"
                onClick={() => void lifecycle(i.id, 'auto-restart', { enabled: !i.autoRestart })}
              >
                {i.autoRestart ? 'on' : 'off'}
              </Button>,
              <span key="a" className="inline-flex gap-1.5">
                {i.state === 'running' ? (
                  <>
                    <Button size="sm" disabled={action.busy} onClick={() => void lifecycle(i.id, 'stop', undefined, `${i.id} stopped`)}>
                      Stop
                    </Button>
                    <Button size="sm" disabled={action.busy} onClick={() => void lifecycle(i.id, 'restart', undefined, `${i.id} restarted`)}>
                      Restart
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={action.busy || i.state === 'starting'}
                    onClick={() => void lifecycle(i.id, 'start', undefined, `${i.id} starting`)}
                  >
                    Start
                  </Button>
                )}
              </span>,
            ])}
            empty={
              <EmptyState
                icon={<Boxes size={22} />}
                title="Nothing provisioned yet"
                hint="Provision your first folder above — it gets its own port, bearer token, and policy."
              />
            }
          />
        )}
        <ErrorNote message={action.error} />
        <p className="mt-3 text-xs text-muted">
          Instance endpoint: <Code>http://127.0.0.1:PORT/mcp</Code> with its bearer token. Changing the preset
          applies on the next start/restart of the instance.
        </p>
      </Card>
    </div>
  );
}
