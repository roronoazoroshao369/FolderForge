import { useMemo, useState } from 'react';
import { Boxes, Copy, FolderSearch, KeyRound, Settings2, Share2 } from 'lucide-react';
import { api } from '../api';
import { useAction, useApi } from '../hooks';
import { FolderPicker } from '../FolderPicker';
import {
  Banner,
  Button,
  Card,
  Code,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  SkeletonRows,
  StatePill,
  useToast,
} from '../ui';
import type { CloudflareStatus, FleetInstance, TunnelRecord } from '../types';

const PRESETS = ['vibe', 'vibe-lite', 'readonly', 'full', 'godot'];
const POLICIES = ['readonly', 'safe', 'dev', 'danger'];

export function FleetScreen() {
  const toast = useToast();
  const fleet = useApi<{ instances: FleetInstance[] }>('/fleet');
  const tunnels = useApi<{ tunnels: TunnelRecord[] }>('/tunnels');
  const action = useAction();
  const [path, setPath] = useState('');
  const [preset, setPreset] = useState('vibe');
  const [policy, setPolicy] = useState('dev');
  const [issued, setIssued] = useState<{ id: string; token: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [configFor, setConfigFor] = useState<FleetInstance | null>(null);
  const [rotated, setRotated] = useState<{ id: string; token: string } | null>(null);
  const [tunnelFor, setTunnelFor] = useState<FleetInstance | null>(null);
  const cf = useApi<CloudflareStatus>('/cloudflare/status');

  const tunnelByPort = useMemo(() => {
    const map = new Map<number, TunnelRecord>();
    for (const t of tunnels.data?.tunnels ?? []) {
      if (t.publicUrl && (t.state === 'running' || t.state === 'starting')) map.set(t.targetPort, t);
    }
    return map;
  }, [tunnels.data]);

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

  const call = async (endpoint: string, body: unknown, label?: string) => {
    const ok = await action.run(endpoint, body);
    if (ok) {
      fleet.reload();
      tunnels.reload();
      if (label) toast('success', label);
    }
    return ok;
  };

  const rotate = async (id: string) => {
    try {
      const result = await api<{ ok?: boolean; data?: { token?: string }; error?: string }>(
        `/fleet/${encodeURIComponent(id)}/rotate-token`,
        { method: 'POST' },
      );
      if (result.ok && result.data?.token) {
        setRotated({ id, token: result.data.token });
        fleet.reload();
      } else {
        toast('error', result.error ?? 'Rotate failed');
      }
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };

  const instances = fleet.data?.instances ?? [];
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Fleet"
        subtitle="Provision, configure, and expose one governed MCP server per folder — as many as you need."
      />

      <Card title="Provision a folder" hint="browse or type the path">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_170px_150px_auto] md:items-end">
          <Field label="Folder path">
            <div className="flex gap-2">
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/absolute/path/to/folder"
                aria-label="Folder path to provision"
              />
              <Button variant="subtle" title="Browse folders on this machine" onClick={() => setPickerOpen(true)}>
                <FolderSearch size={14} aria-hidden /> Browse
              </Button>
            </div>
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

      <div>
        <div className="flex items-center justify-between gap-4 mb-3">
          <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[1px] text-muted">Instances</h2>
          <span className="text-xs text-muted">{instances.length} provisioned</span>
        </div>
        {fleet.loading ? (
          <SkeletonRows rows={2} />
        ) : instances.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Boxes size={22} />}
              title="Nothing provisioned yet"
              hint="Pick a folder above (Browse → or type the path, or create a new folder inside the picker) — it gets its own port, bearer token, and policy."
            />
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {instances.map((i) => {
              const tunnel = tunnelByPort.get(i.port);
              return (
                <div
                  key={i.id}
                  className="rounded-[14px] border border-border bg-gradient-to-b from-panel-2 to-panel p-4 grid gap-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Code>{i.id}</Code>
                        <StatePill value={i.state} />
                      </div>
                      <div className="mt-1 text-xs text-muted truncate" title={i.projectPath}>
                        {i.projectPath}
                      </div>
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      {i.state === 'running' ? (
                        <>
                          <Button
                            size="sm"
                            disabled={action.busy}
                            onClick={() =>
                              void call(`/fleet/${encodeURIComponent(i.id)}/stop`, undefined, `${i.id} stopped`)
                            }
                          >
                            Stop
                          </Button>
                          <Button
                            size="sm"
                            disabled={action.busy}
                            onClick={() =>
                              void call(`/fleet/${encodeURIComponent(i.id)}/restart`, undefined, `${i.id} restarted`)
                            }
                          >
                            Restart
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={action.busy || i.state === 'starting'}
                          onClick={() =>
                            void call(`/fleet/${encodeURIComponent(i.id)}/start`, undefined, `${i.id} starting`)
                          }
                        >
                          Start
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
                    <span className="text-muted">Endpoint</span>
                    <Code>http://127.0.0.1:{i.port}/mcp</Code>
                    <span className="text-muted">Tool preset</span>
                    <Code>{i.toolsPreset}</Code>
                    <span className="text-muted">Policy mode</span>
                    <Code>{i.policyMode}</Code>
                    <span className="text-muted">Auto-restart</span>
                    <Button
                      size="sm"
                      variant={i.autoRestart ? 'primary' : 'ghost'}
                      className="w-fit"
                      disabled={action.busy}
                      title="Restart automatically after an unexpected exit"
                      onClick={() =>
                        void call(`/fleet/${encodeURIComponent(i.id)}/auto-restart`, { enabled: !i.autoRestart })
                      }
                    >
                      {i.autoRestart ? 'on' : 'off'}
                    </Button>
                  </div>

                  {i.state === 'failed' && i.lastError ? (
                    <div className="rounded-lg border border-[#6b3535] bg-[#2b1414]/60 px-2.5 py-2 text-xs text-[#f09a9a]">
                      <span className="font-medium">Last error: </span>
                      {i.lastError}
                    </div>
                  ) : null}

                  {tunnel?.publicUrl ? (
                    <div className="rounded-lg border border-[#26476b] bg-[#0d1b2c]/60 px-2.5 py-2 text-xs">
                      <span className="text-muted">Public tunnel: </span>
                      <a
                        href={`${tunnel.publicUrl}/mcp`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-blue hover:underline break-all"
                      >
                        {tunnel.publicUrl}/mcp
                      </a>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border-soft">
                    <Button size="sm" variant="ghost" onClick={() => setConfigFor(i)}>
                      <Settings2 size={13} aria-hidden /> Configure
                    </Button>
                    <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => void rotate(i.id)}>
                      <KeyRound size={13} aria-hidden /> Rotate token
                    </Button>
                    {i.state === 'running' && !tunnel ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={action.busy}
                        onClick={() => setTunnelFor(i)}
                      >
                        <Share2 size={13} aria-hidden /> Start tunnel
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <ErrorNote message={action.error} />
      </div>

      <FolderPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(selected) => setPath(selected)}
      />

      {configFor ? (
        <ConfigModal
          instance={configFor}
          onClose={() => setConfigFor(null)}
          onSaved={() => {
            setConfigFor(null);
            fleet.reload();
          }}
        />
      ) : null}

      {rotated ? (
        <Modal open title={`New token for ${rotated.id}`} onClose={() => setRotated(null)}>
          <div className="grid gap-3">
            <Banner tone="warn">
              Shown exactly once — copy it now. The old token stops working on the next start/restart.
            </Banner>
            <Code className="block rounded-lg bg-[#0b1119] px-2.5 py-2 text-warn break-all">{rotated.token}</Code>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  navigator.clipboard
                    .writeText(rotated.token)
                    .then(() => toast('success', 'Token copied to clipboard'))
                    .catch(() => undefined);
                }}
              >
                <Copy size={13} aria-hidden /> Copy
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRotated(null)}>
                Done
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {tunnelFor ? (
        <TunnelModal
          instance={tunnelFor}
          cf={cf.data}
          busy={action.busy}
          error={action.error}
          onClose={() => setTunnelFor(null)}
          onStart={(hostname) => {
            void call(
              `/fleet/${encodeURIComponent(tunnelFor.id)}/tunnel`,
              hostname ? { hostname } : undefined,
              hostname
                ? `Named tunnel ${hostname} starting — DNS + tunnel created on your domain`
                : `Tunnel starting for ${tunnelFor.id} — public URL appears shortly`,
            ).then((ok) => {
              if (ok) setTunnelFor(null);
            });
          }}
        />
      ) : null}
    </div>
  );
}

function ConfigModal(props: { instance: FleetInstance; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const action = useAction();
  const [preset, setPreset] = useState(props.instance.toolsPreset);
  const [policy, setPolicy] = useState(props.instance.policyMode);

  const save = async () => {
    const id = encodeURIComponent(props.instance.id);
    if (preset !== props.instance.toolsPreset) {
      const ok = await action.run(`/fleet/${id}/preset`, { toolsPreset: preset });
      if (!ok) return;
    }
    if (policy !== props.instance.policyMode) {
      const ok = await action.run(`/fleet/${id}/policy`, { policyMode: policy });
      if (!ok) return;
    }
    toast('success', `${props.instance.id} updated — restart to apply`);
    props.onSaved();
  };

  return (
    <Modal open title={`Configure ${props.instance.id}`} onClose={props.onClose}>
      <div className="grid gap-3">
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
        <Banner tone="info">Changes apply on the next start/restart of the instance.</Banner>
        <ErrorNote message={action.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={action.busy} onClick={() => void save()}>
            Save changes
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TunnelModal(props: {
  instance: FleetInstance;
  cf: CloudflareStatus | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onStart: (hostname?: string) => void;
}) {
  const [mode, setMode] = useState<'quick' | 'named'>('quick');
  const [sub, setSub] = useState('');
  const domain = props.cf && props.cf.configured ? props.cf.domain : undefined;
  const subClean = sub.trim().toLowerCase();
  const subValid = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subClean);
  const hostname = mode === 'named' && domain && subValid ? `${subClean}.${domain}` : undefined;

  return (
    <Modal open title={`Start tunnel for ${props.instance.id}`} onClose={props.onClose}>
      <div className="grid gap-3">
        <label className="flex items-start gap-2 rounded-lg border border-border-soft px-3 py-2 text-sm">
          <input
            type="radio"
            name="tunnel-mode"
            checked={mode === 'quick'}
            onChange={() => setMode('quick')}
            aria-label="Quick tunnel"
          />
          <span>
            <strong>Quick tunnel</strong>
            <span className="block text-xs text-muted">
              Random <Code>*.trycloudflare.com</Code> URL — instant, but changes every time.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 rounded-lg border border-border-soft px-3 py-2 text-sm">
          <input
            type="radio"
            name="tunnel-mode"
            checked={mode === 'named'}
            onChange={() => setMode('named')}
            disabled={!domain}
            aria-label="Named tunnel"
          />
          <span>
            <strong>Named tunnel + DNS</strong>
            <span className="block text-xs text-muted">
              {domain
                ? `Stable subdomain on ${domain} — Cloudflare tunnel, DNS CNAME and cloudflared are set up for you.`
                : 'Link a Cloudflare account on the Tunnels screen to unlock stable subdomains.'}
            </span>
          </span>
        </label>
        {mode === 'named' && domain ? (
          <Field label="Subdomain">
            <div className="flex items-center gap-1.5">
              <Input
                value={sub}
                onChange={(e) => setSub(e.target.value)}
                placeholder="mcp1"
                aria-label="Subdomain label"
                className="w-44"
              />
              <span className="text-sm text-muted">.{domain}</span>
            </div>
          </Field>
        ) : null}
        {hostname ? (
          <Banner tone="info">
            Public endpoint will be <Code>https://{hostname}/mcp</Code> — keep requiring the instance
            token.
          </Banner>
        ) : null}
        <ErrorNote message={props.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={props.busy}
            disabled={mode === 'named' && !hostname}
            onClick={() => props.onStart(hostname)}
          >
            <Share2 size={13} aria-hidden /> Start tunnel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
