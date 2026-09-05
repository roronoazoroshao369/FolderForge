import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  Copy,
  FolderSearch,
  KeyRound,
  Plug,
  RadioTower,
  ScrollText,
  Settings2,
  Share2,
  ShieldCheck,
} from 'lucide-react';
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
import type {
  CloudflareStatus,
  FleetAuthMode,
  FleetInstance,
  FleetOAuthConfig,
  TunnelRecord,
} from '../types';

const PRESETS = ['vibe', 'vibe-lite', 'readonly', 'full', 'godot', 'adaptive'];
const POLICIES = ['readonly', 'safe', 'dev', 'danger'];
const AUTH_MODES: FleetAuthMode[] = ['token', 'api-key', 'oauth', 'none'];

interface OneTimeCredential {
  id: string;
  kind: 'token' | 'api-key';
  value: string;
  reason: 'created' | 'rotated' | 'auth-changed';
}

function oauthBody(input: {
  resource: string;
  issuer: string;
  scopes: string;
  readScope: string;
  writeScope: string;
  clientRegistration: string;
}): FleetOAuthConfig {
  return {
    resource: input.resource.trim(),
    issuer: input.issuer.trim(),
    scopes: input.scopes.split(',').map((item) => item.trim()).filter(Boolean),
    readScope: input.readScope.trim(),
    writeScope: input.writeScope.trim(),
    clientRegistration: input.clientRegistration as FleetOAuthConfig['clientRegistration'],
  };
}

function authLabel(mode: FleetAuthMode): string {
  if (mode === 'api-key') return 'API key';
  if (mode === 'oauth') return 'OAuth';
  if (mode === 'none') return 'No auth';
  return 'Bearer token';
}

export function FleetScreen() {
  const toast = useToast();
  const fleet = useApi<{ instances: FleetInstance[] }>('/fleet');
  const tunnels = useApi<{ tunnels: TunnelRecord[] }>('/tunnels');
  const action = useAction();
  const cf = useApi<CloudflareStatus>('/cloudflare/status');

  const [path, setPath] = useState('');
  const [preset, setPreset] = useState('vibe');
  const [policy, setPolicy] = useState('dev');
  const [authMode, setAuthMode] = useState<FleetAuthMode>('token');
  const [apiKey, setApiKey] = useState('');
  const [oauthResource, setOauthResource] = useState('');
  const [oauthIssuer, setOauthIssuer] = useState('');
  const [oauthScopes, setOauthScopes] = useState('folderforge:read, folderforge:write');
  const [oauthReadScope, setOauthReadScope] = useState('folderforge:read');
  const [oauthWriteScope, setOauthWriteScope] = useState('folderforge:write');
  const [oauthRegistration, setOauthRegistration] = useState('cimd');
  const [credential, setCredential] = useState<OneTimeCredential | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [configFor, setConfigFor] = useState<FleetInstance | null>(null);
  const [authFor, setAuthFor] = useState<FleetInstance | null>(null);
  const [tunnelFor, setTunnelFor] = useState<FleetInstance | null>(null);
  const [openAiFor, setOpenAiFor] = useState<FleetInstance | null>(null);
  const [logsFor, setLogsFor] = useState<FleetInstance | null>(null);
  const [connectFor, setConnectFor] = useState<FleetInstance | null>(null);

  const tunnelByPort = useMemo(() => {
    const map = new Map<number, TunnelRecord>();
    for (const tunnel of tunnels.data?.tunnels ?? []) {
      if (tunnel.publicUrl && (tunnel.state === 'running' || tunnel.state === 'starting')) {
        map.set(tunnel.targetPort, tunnel);
      }
    }
    return map;
  }, [tunnels.data]);

  const provision = async () => {
    setFormError(null);
    try {
      const body: Record<string, unknown> = {
        projectPath: path.trim(),
        toolsPreset: preset,
        policyMode: policy,
        authMode,
      };
      if (authMode === 'api-key' && apiKey.trim()) body.apiKey = apiKey.trim();
      if (authMode === 'oauth') {
        body.oauth = oauthBody({
          resource: oauthResource,
          issuer: oauthIssuer,
          scopes: oauthScopes,
          readScope: oauthReadScope,
          writeScope: oauthWriteScope,
          clientRegistration: oauthRegistration,
        });
      }
      const result = await api<{
        ok?: boolean;
        data?: { id?: string; token?: string; apiKey?: string };
        error?: string;
      }>('/fleet', { method: 'POST', body });
      if (!result.ok || !result.data?.id) {
        setFormError(result.error ?? 'Provision failed.');
        return;
      }
      if (result.data.token) {
        setCredential({ id: result.data.id, kind: 'token', value: result.data.token, reason: 'created' });
      } else if (result.data.apiKey) {
        setCredential({ id: result.data.id, kind: 'api-key', value: result.data.apiKey, reason: 'created' });
      }
      setPath('');
      setApiKey('');
      fleet.reload();
      toast('success', `Provisioned ${result.data.id}`);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
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

  const rotate = async (instance: FleetInstance) => {
    try {
      const result = await api<{
        ok?: boolean;
        data?: { credential?: string; kind?: 'token' | 'api-key' };
        error?: string;
      }>(`/fleet/${encodeURIComponent(instance.id)}/rotate-credential`, { method: 'POST' });
      if (result.ok && result.data?.credential && result.data.kind) {
        setCredential({
          id: instance.id,
          kind: result.data.kind,
          value: result.data.credential,
          reason: 'rotated',
        });
        fleet.reload();
      } else {
        toast('error', result.error ?? 'Credential rotation failed');
      }
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    }
  };

  const instances = fleet.data?.instances ?? [];
  const oauthMissing = authMode === 'oauth' && (!oauthResource.trim() || !oauthIssuer.trim());

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Fleet"
        subtitle="Provision and operate one governed MCP server per folder, with independent authentication and exposure choices."
      />

      <Card title="Provision a folder" hint="local first; expose only when authenticated">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_150px_140px_150px_auto] lg:items-end">
          <Field label="Folder path">
            <div className="flex gap-2">
              <Input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/absolute/path/to/folder"
                aria-label="Folder path to provision"
              />
              <Button variant="subtle" title="Browse folders on this machine" onClick={() => setPickerOpen(true)}>
                <FolderSearch size={14} aria-hidden /> Browse
              </Button>
            </div>
          </Field>
          <Field label="Tool preset">
            <Select value={preset} onChange={(event) => setPreset(event.target.value)} aria-label="Tool preset">
              {PRESETS.map((value) => <option key={value} value={value}>{value}</option>)}
            </Select>
          </Field>
          <Field label="Policy mode">
            <Select value={policy} onChange={(event) => setPolicy(event.target.value)} aria-label="Policy mode">
              {POLICIES.map((value) => <option key={value} value={value}>{value}</option>)}
            </Select>
          </Field>
          <Field label="Authentication">
            <Select
              value={authMode}
              onChange={(event) => setAuthMode(event.target.value as FleetAuthMode)}
              aria-label="Authentication mode"
            >
              {AUTH_MODES.map((value) => <option key={value} value={value}>{authLabel(value)}</option>)}
            </Select>
          </Field>
          <Button
            variant="primary"
            disabled={!path.trim() || oauthMissing || action.busy}
            busy={action.busy}
            onClick={() => void provision()}
          >
            Provision
          </Button>
        </div>

        {authMode === 'api-key' ? (
          <div className="mt-3 max-w-xl">
            <Field label="API key (optional)">
              <Input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Leave blank to generate a FolderForge API key"
                aria-label="Optional API key"
              />
            </Field>
          </div>
        ) : null}

        {authMode === 'oauth' ? (
          <div className="mt-3 grid gap-3 rounded-xl border border-border-soft p-3 md:grid-cols-2">
            <Field label="OAuth resource / audience">
              <Input value={oauthResource} onChange={(event) => setOauthResource(event.target.value)} placeholder="https://mcp.example.com" />
            </Field>
            <Field label="Authorization issuer">
              <Input value={oauthIssuer} onChange={(event) => setOauthIssuer(event.target.value)} placeholder="https://tenant.auth0.com/" />
            </Field>
            <Field label="Scopes (comma-separated)">
              <Input value={oauthScopes} onChange={(event) => setOauthScopes(event.target.value)} />
            </Field>
            <Field label="Client registration">
              <Select value={oauthRegistration} onChange={(event) => setOauthRegistration(event.target.value)}>
                <option value="cimd">CIMD</option>
                <option value="dcr">DCR</option>
                <option value="predefined">Predefined</option>
              </Select>
            </Field>
            <Field label="Read scope">
              <Input value={oauthReadScope} onChange={(event) => setOauthReadScope(event.target.value)} />
            </Field>
            <Field label="Write scope">
              <Input value={oauthWriteScope} onChange={(event) => setOauthWriteScope(event.target.value)} />
            </Field>
          </div>
        ) : null}

        {authMode === 'none' ? (
          <div className="mt-3">
            <Banner tone="warn">No-auth instances stay loopback-only. Mission Control will refuse Cloudflare publication.</Banner>
          </div>
        ) : null}
        <ErrorNote message={formError ?? fleet.error} />
      </Card>

      <div>
        <div className="mb-3 flex items-center justify-between gap-4">
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
              hint="Choose a folder, policy, tool preset, and authentication mode above."
            />
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {instances.map((instance) => {
              const tunnel = tunnelByPort.get(instance.port);
              const openAiRunning =
                instance.openAiTunnel?.state === 'running' || instance.openAiTunnel?.state === 'starting';
              return (
                <div key={instance.id} className="grid gap-3 rounded-[14px] border border-border bg-gradient-to-b from-panel-2 to-panel p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Code>{instance.id}</Code>
                        <StatePill value={instance.state} />
                        {openAiRunning ? <StatePill value="openai-tunnel" /> : null}
                        {instance.state === 'running' && instance.leaseId ? (
                          <StatePill value={`lease ${instance.leaseId.replace(/^lse_/, '').slice(0, 8)}`} />
                        ) : null}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted" title={instance.projectPath}>{instance.projectPath}</div>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      {instance.state === 'running' ? (
                        <>
                          <Button size="sm" disabled={action.busy} onClick={() => void call(`/fleet/${encodeURIComponent(instance.id)}/stop`, undefined, `${instance.id} stopped`)}>Stop</Button>
                          <Button size="sm" disabled={action.busy} onClick={() => void call(`/fleet/${encodeURIComponent(instance.id)}/restart`, undefined, `${instance.id} restarted`)}>Restart</Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={action.busy || instance.state === 'starting' || openAiRunning}
                          title={openAiRunning ? 'Stop the OpenAI tunnel supervisor first' : undefined}
                          onClick={() => void call(`/fleet/${encodeURIComponent(instance.id)}/start`, undefined, `${instance.id} starting`)}
                        >
                          Start local
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
                    <span className="text-muted">Endpoint</span><Code>http://127.0.0.1:{instance.port}/mcp</Code>
                    <span className="text-muted">Authentication</span><Code>{authLabel(instance.authMode)}</Code>
                    <span className="text-muted">Tool preset</span><Code>{instance.toolsPreset}</Code>
                    <span className="text-muted">Policy mode</span><Code>{instance.policyMode}</Code>
                    <span className="text-muted">Auto-restart</span>
                    <Button
                      size="sm"
                      variant={instance.autoRestart ? 'primary' : 'ghost'}
                      className="w-fit"
                      disabled={action.busy}
                      onClick={() => void call(`/fleet/${encodeURIComponent(instance.id)}/auto-restart`, { enabled: !instance.autoRestart })}
                    >
                      {instance.autoRestart ? 'on' : 'off'}
                    </Button>
                  </div>

                  {instance.oauth ? (
                    <div className="rounded-lg border border-border-soft px-2.5 py-2 text-xs">
                      <span className="text-muted">OAuth resource: </span><Code>{instance.oauth.resource}</Code>
                    </div>
                  ) : null}
                  {instance.state === 'failed' && instance.lastError ? (
                    <div className="rounded-lg border border-[#6b3535] bg-[#2b1414]/60 px-2.5 py-2 text-xs text-[#f09a9a]">
                      <span className="font-medium">Last error: </span>{instance.lastError}
                    </div>
                  ) : null}
                  {instance.openAiTunnel?.lastError ? (
                    <div className="rounded-lg border border-[#6b3535] bg-[#2b1414]/60 px-2.5 py-2 text-xs text-[#f09a9a]">
                      <span className="font-medium">OpenAI tunnel: </span>{instance.openAiTunnel.lastError}
                    </div>
                  ) : null}
                  {tunnel?.publicUrl ? (
                    <div className="rounded-lg border border-[#26476b] bg-[#0d1b2c]/60 px-2.5 py-2 text-xs">
                      <span className="text-muted">Cloudflare: </span>
                      <a href={`${tunnel.publicUrl}/mcp`} target="_blank" rel="noreferrer" className="break-all font-mono text-blue hover:underline">
                        {tunnel.publicUrl}/mcp
                      </a>
                    </div>
                  ) : null}
                  {instance.openAiTunnel ? (
                    <div className="rounded-lg border border-[#26476b] bg-[#0d1b2c]/60 px-2.5 py-2 text-xs">
                      <span className="text-muted">OpenAI tunnel: </span><Code>{instance.openAiTunnel.tunnelId}</Code>
                      <span className="ml-2 text-muted">mode: {instance.openAiTunnel.oauth ? 'OAuth' : 'static token'}</span>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-1.5 border-t border-border-soft pt-1">
                    <Button size="sm" variant="ghost" onClick={() => setConfigFor(instance)}><Settings2 size={13} aria-hidden /> Configure</Button>
                    <Button size="sm" variant="ghost" onClick={() => setAuthFor(instance)}><ShieldCheck size={13} aria-hidden /> Auth</Button>
                    {(instance.authMode === 'token' || instance.authMode === 'api-key') ? (
                      <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => void rotate(instance)}>
                        <KeyRound size={13} aria-hidden /> Rotate {instance.authMode === 'api-key' ? 'API key' : 'token'}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => setLogsFor(instance)}><ScrollText size={13} aria-hidden /> Logs</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConnectFor(instance)}><Plug size={13} aria-hidden /> Connect</Button>
                    {instance.state === 'running' && !tunnel && instance.authMode !== 'none' ? (
                      <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => setTunnelFor(instance)}>
                        <Share2 size={13} aria-hidden /> Cloudflare
                      </Button>
                    ) : null}
                    {openAiRunning ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={action.busy}
                        onClick={() => void call(`/fleet/${encodeURIComponent(instance.id)}/openai-tunnel/stop`, undefined, `OpenAI tunnel stopped for ${instance.id}`)}
                      >
                        <RadioTower size={13} aria-hidden /> Stop OpenAI
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={action.busy || instance.state === 'running' || instance.state === 'starting'}
                        title={instance.state === 'running' ? 'Stop the local instance first; OpenAI Tunnel supervises its own local MCP child' : undefined}
                        onClick={() => setOpenAiFor(instance)}
                      >
                        <RadioTower size={13} aria-hidden /> OpenAI Tunnel
                      </Button>
                    )}
                  </div>
                  {instance.authMode === 'none' && instance.state === 'running' && !tunnel ? (
                    <div className="text-xs text-muted">Cloudflare exposure is disabled until authentication is enabled.</div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        <ErrorNote message={action.error} />
      </div>

      <FolderPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={(selected) => setPath(selected)} />

      {configFor ? (
        <ConfigModal instance={configFor} onClose={() => setConfigFor(null)} onSaved={() => { setConfigFor(null); fleet.reload(); }} />
      ) : null}
      {authFor ? (
        <AuthModal
          instance={authFor}
          onClose={() => setAuthFor(null)}
          onSaved={(nextCredential) => {
            setAuthFor(null);
            if (nextCredential) setCredential(nextCredential);
            fleet.reload();
          }}
        />
      ) : null}
      {credential ? <CredentialModal credential={credential} onClose={() => setCredential(null)} /> : null}
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
              hostname ? `Named tunnel ${hostname} starting` : `Cloudflare tunnel starting for ${tunnelFor.id}`,
            ).then((ok) => { if (ok) setTunnelFor(null); });
          }}
        />
      ) : null}
      {openAiFor ? (
        <OpenAiTunnelModal
          instance={openAiFor}
          onClose={() => setOpenAiFor(null)}
          onStarted={() => { setOpenAiFor(null); fleet.reload(); }}
        />
      ) : null}
      {logsFor ? <LogsModal instance={logsFor} onClose={() => setLogsFor(null)} /> : null}
      {connectFor ? (
        <ConnectModal instance={connectFor} publicUrl={tunnelByPort.get(connectFor.port)?.publicUrl} onClose={() => setConnectFor(null)} />
      ) : null}
    </div>
  );
}

function CredentialModal(props: { credential: OneTimeCredential; onClose: () => void }) {
  const toast = useToast();
  const label = props.credential.kind === 'api-key' ? 'API key' : 'bearer token';
  return (
    <Modal open title={`New ${label} for ${props.credential.id}`} onClose={props.onClose}>
      <div className="grid gap-3">
        <Banner tone="warn">Shown exactly once — copy it now. Plaintext is not stored in Fleet state.</Banner>
        <Code className="block break-all rounded-lg bg-[#0b1119] px-2.5 py-2 text-warn">{props.credential.value}</Code>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => navigator.clipboard.writeText(props.credential.value).then(() => toast('success', `${label} copied`)).catch(() => undefined)}
          >
            <Copy size={13} aria-hidden /> Copy
          </Button>
          <Button size="sm" variant="ghost" onClick={props.onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}

function ConfigModal(props: { instance: FleetInstance; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const action = useAction();
  const [preset, setPreset] = useState(props.instance.toolsPreset);
  const [policy, setPolicy] = useState(props.instance.policyMode);
  const save = async () => {
    const id = encodeURIComponent(props.instance.id);
    if (preset !== props.instance.toolsPreset && !(await action.run(`/fleet/${id}/preset`, { toolsPreset: preset }))) return;
    if (policy !== props.instance.policyMode && !(await action.run(`/fleet/${id}/policy`, { policyMode: policy }))) return;
    toast('success', `${props.instance.id} updated — restart to apply`);
    props.onSaved();
  };
  return (
    <Modal open title={`Configure ${props.instance.id}`} onClose={props.onClose}>
      <div className="grid gap-3">
        <Field label="Tool preset"><Select value={preset} onChange={(event) => setPreset(event.target.value)}>{PRESETS.map((value) => <option key={value}>{value}</option>)}</Select></Field>
        <Field label="Policy mode"><Select value={policy} onChange={(event) => setPolicy(event.target.value)}>{POLICIES.map((value) => <option key={value}>{value}</option>)}</Select></Field>
        <Banner tone="info">Preset and policy changes apply on the next local start/restart and on future OpenAI Tunnel launches.</Banner>
        <ErrorNote message={action.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={props.onClose}>Cancel</Button><Button variant="primary" busy={action.busy} onClick={() => void save()}>Save changes</Button></div>
      </div>
    </Modal>
  );
}

function AuthModal(props: {
  instance: FleetInstance;
  onClose: () => void;
  onSaved: (credential: OneTimeCredential | null) => void;
}) {
  const action = useAction();
  const [mode, setMode] = useState<FleetAuthMode>(props.instance.authMode);
  const [apiKey, setApiKey] = useState('');
  const [resource, setResource] = useState(props.instance.oauth?.resource ?? '');
  const [issuer, setIssuer] = useState(props.instance.oauth?.issuer ?? '');
  const [scopes, setScopes] = useState(props.instance.oauth?.scopes.join(', ') ?? 'folderforge:read, folderforge:write');
  const [readScope, setReadScope] = useState(props.instance.oauth?.readScope ?? 'folderforge:read');
  const [writeScope, setWriteScope] = useState(props.instance.oauth?.writeScope ?? 'folderforge:write');
  const [registration, setRegistration] = useState<string>(props.instance.oauth?.clientRegistration ?? 'cimd');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    try {
      const body: Record<string, unknown> = { mode };
      if (mode === 'api-key' && apiKey.trim()) body.apiKey = apiKey.trim();
      if (mode === 'oauth') {
        body.oauth = oauthBody({ resource, issuer, scopes, readScope, writeScope, clientRegistration: registration });
      }
      const result = await api<{
        ok?: boolean;
        data?: { token?: string; apiKey?: string; restartRequired?: boolean };
        error?: string;
      }>(`/fleet/${encodeURIComponent(props.instance.id)}/auth`, { method: 'POST', body });
      if (!result.ok) {
        setError(result.error ?? 'Authentication update failed.');
        return;
      }
      let next: OneTimeCredential | null = null;
      if (result.data?.token) next = { id: props.instance.id, kind: 'token', value: result.data.token, reason: 'auth-changed' };
      if (result.data?.apiKey) next = { id: props.instance.id, kind: 'api-key', value: result.data.apiKey, reason: 'auth-changed' };
      props.onSaved(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <Modal open title={`Authentication — ${props.instance.id}`} onClose={props.onClose}>
      <div className="grid gap-3">
        <Field label="Mode">
          <Select value={mode} onChange={(event) => setMode(event.target.value as FleetAuthMode)}>
            {AUTH_MODES.map((value) => <option key={value} value={value}>{authLabel(value)}</option>)}
          </Select>
        </Field>
        {mode === 'api-key' ? (
          <Field label="API key (optional)"><Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Leave blank to generate a new API key" /></Field>
        ) : null}
        {mode === 'oauth' ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="OAuth resource"><Input value={resource} onChange={(event) => setResource(event.target.value)} /></Field>
            <Field label="Issuer"><Input value={issuer} onChange={(event) => setIssuer(event.target.value)} /></Field>
            <Field label="Scopes"><Input value={scopes} onChange={(event) => setScopes(event.target.value)} /></Field>
            <Field label="Registration"><Select value={registration} onChange={(event) => setRegistration(event.target.value)}><option value="cimd">CIMD</option><option value="dcr">DCR</option><option value="predefined">Predefined</option></Select></Field>
            <Field label="Read scope"><Input value={readScope} onChange={(event) => setReadScope(event.target.value)} /></Field>
            <Field label="Write scope"><Input value={writeScope} onChange={(event) => setWriteScope(event.target.value)} /></Field>
          </div>
        ) : null}
        {mode === 'none' ? <Banner tone="warn">No auth is allowed only for local loopback use. Cloudflare exposure will be blocked.</Banner> : null}
        {(mode === 'token' || mode === 'api-key') && mode !== props.instance.authMode ? (
          <Banner tone="warn">Changing to this mode issues a fresh credential exactly once.</Banner>
        ) : null}
        <ErrorNote message={error ?? action.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={props.onClose}>Cancel</Button><Button variant="primary" busy={action.busy} onClick={() => void save()}>Apply auth</Button></div>
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
  const domain = props.cf?.configured ? props.cf.domain : undefined;
  const subClean = sub.trim().toLowerCase();
  const subValid = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subClean);
  const hostname = mode === 'named' && domain && subValid ? `${subClean}.${domain}` : undefined;
  return (
    <Modal open title={`Cloudflare exposure — ${props.instance.id}`} onClose={props.onClose}>
      <div className="grid gap-3">
        <Banner tone="warn">Public exposure keeps the instance authentication requirement. No-auth Fleet instances cannot be published.</Banner>
        <label className="flex items-start gap-2 rounded-lg border border-border-soft px-3 py-2 text-sm">
          <input type="radio" name="tunnel-mode" checked={mode === 'quick'} onChange={() => setMode('quick')} />
          <span><strong>Quick tunnel</strong><span className="block text-xs text-muted">Temporary random <Code>*.trycloudflare.com</Code> URL.</span></span>
        </label>
        <label className="flex items-start gap-2 rounded-lg border border-border-soft px-3 py-2 text-sm">
          <input type="radio" name="tunnel-mode" checked={mode === 'named'} onChange={() => setMode('named')} disabled={!domain} />
          <span><strong>Named tunnel + DNS</strong><span className="block text-xs text-muted">{domain ? `Stable subdomain on ${domain}.` : 'Link Cloudflare on the Tunnels screen first.'}</span></span>
        </label>
        {mode === 'named' && domain ? <Field label="Subdomain"><div className="flex items-center gap-1.5"><Input value={sub} onChange={(event) => setSub(event.target.value)} placeholder="mcp1" className="w-44" /><span className="text-sm text-muted">.{domain}</span></div></Field> : null}
        <ErrorNote message={props.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={props.onClose}>Cancel</Button><Button variant="primary" busy={props.busy} disabled={mode === 'named' && !hostname} onClick={() => props.onStart(hostname)}><Share2 size={13} aria-hidden /> Start Cloudflare</Button></div>
      </div>
    </Modal>
  );
}

function OpenAiTunnelModal(props: { instance: FleetInstance; onClose: () => void; onStarted: () => void }) {
  const [tunnelId, setTunnelId] = useState(props.instance.openAiTunnel?.tunnelId ?? '');
  const [apiKeyEnv, setApiKeyEnv] = useState(props.instance.openAiTunnel?.apiKeyEnv ?? 'CONTROL_PLANE_API_KEY');
  const [apiKey, setApiKey] = useState('');
  const [verify, setVerify] = useState<{ ok: boolean; text: string } | null>(null);
  const [oauth, setOauth] = useState(props.instance.authMode === 'oauth');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ ok?: boolean; error?: string }>(`/fleet/${encodeURIComponent(props.instance.id)}/openai-tunnel/start`, {
        method: 'POST',
        body: {
          tunnelId: tunnelId.trim(),
          apiKeyEnv: apiKeyEnv.trim(),
          oauth,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
      });
      if (!result.ok) {
        setError(result.error ?? 'OpenAI tunnel failed to start.');
        return;
      }
      props.onStarted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  // Verify probes the OpenAI API with the pasted key without persisting anything.
  const verifyKey = async () => {
    setBusy(true);
    setVerify(null);
    try {
      const result = await api<{ ok?: boolean; message?: string }>('/openai-tunnel/verify', {
        method: 'POST',
        body: { apiKey: apiKey.trim() },
      });
      setVerify({ ok: true, text: result.message ?? 'Key authenticated with OpenAI' });
    } catch (caught) {
      setVerify({ ok: false, text: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title={`OpenAI Secure MCP Tunnel — ${props.instance.id}`} onClose={props.onClose}>
      <div className="grid gap-3">
        <Banner tone="info">
          This reuses <Code>folderforge connect chatgpt --openai-tunnel</Code>. Stop the normal local instance first; the supervisor launches its own loopback MCP child.
        </Banner>
        <Field label="OpenAI tunnel ID"><Input value={tunnelId} onChange={(event) => setTunnelId(event.target.value)} placeholder="tunnel_0123456789abcdef0123456789abcdef" /></Field>
        <Field label="Runtime API-key environment variable"><Input value={apiKeyEnv} onChange={(event) => setApiKeyEnv(event.target.value)} placeholder="CONTROL_PLANE_API_KEY" /></Field>
        <Field label="OpenAI API key (optional — paste directly)"><Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-... — stored in the 0600 fleet state" aria-label="OpenAI API key value (stored locally, optional)" /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={oauth} onChange={(event) => setOauth(event.target.checked)} /><span>Use OAuth/Auth0 mode instead of legacy static-token tunnel mode</span></label>
        <Banner tone="info">
          Paste the key here (stored in the 0600 fleet state, injected into the supervisor's environment) or export the env var before <Code>folderforge control start</Code> — either works; an exported env var wins over a stored key.
        </Banner>
        {verify?.ok ? (
          <p className="text-xs text-green">{verify.text}</p>
        ) : (
          <ErrorNote message={verify?.text ?? null} />
        )}
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" disabled={!apiKey.trim() || busy} busy={busy} onClick={() => void verifyKey()}>Verify key</Button><Button variant="ghost" onClick={props.onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!tunnelId.trim() || !apiKeyEnv.trim()} onClick={() => void start()}><RadioTower size={13} aria-hidden /> Start OpenAI Tunnel</Button></div>
      </div>
    </Modal>
  );
}

function LogsModal(props: { instance: FleetInstance; onClose: () => void }) {
  const [logs, setLogs] = useState<{ status?: string; output?: string } | null>(null);
  const [openAiLogs, setOpenAiLogs] = useState<{ output?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      if (props.instance.openAiTunnel?.state === 'running' || props.instance.openAiTunnel?.state === 'starting') {
        setOpenAiLogs(await api<{ output?: string }>(`/fleet/${encodeURIComponent(props.instance.id)}/openai-tunnel/logs`));
        setLogs(null);
      } else {
        setLogs(await api<{ status?: string; output?: string }>(`/fleet/${encodeURIComponent(props.instance.id)}/logs`));
        setOpenAiLogs(null);
      }
      setError(null);
    } catch (caught) {
      setLogs(null);
      setOpenAiLogs(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [props.instance.id, props.instance.openAiTunnel?.state]);
  useEffect(() => { void load(); }, [load]);
  const output = openAiLogs?.output ?? logs?.output ?? '';
  return (
    <Modal open title={`Logs — ${props.instance.id}`} onClose={props.onClose}>
      <div className="grid gap-3">
        <ErrorNote message={error} />
        <div className="text-xs text-muted">source: {openAiLogs ? 'OpenAI tunnel supervisor' : 'local Fleet process'}</div>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border-soft bg-[#0b1119] p-3 font-mono text-[11px] leading-relaxed">{output.trim() ? output : 'No output captured yet.'}</pre>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => void load()}>Refresh</Button><Button variant="primary" onClick={props.onClose}>Close</Button></div>
      </div>
    </Modal>
  );
}

function ConnectModal(props: { instance: FleetInstance; publicUrl?: string; onClose: () => void }) {
  const toast = useToast();
  const localEndpoint = `http://127.0.0.1:${props.instance.port}/mcp`;
  const endpoint = props.publicUrl ? `${props.publicUrl}/mcp` : localEndpoint;
  const name = `folderforge-${props.instance.id}`;
  const headers =
    props.instance.authMode === 'token'
      ? ',\n      "headers": { "Authorization": "Bearer <paste the instance token here>" }'
      : props.instance.authMode === 'api-key'
        ? ',\n      "headers": { "X-API-Key": "<paste the instance API key here>" }'
        : '';
  const snippet =
    '{\n' +
    '  "mcpServers": {\n' +
    `    "${name}": {\n` +
    `      "url": "${endpoint}"${headers}\n` +
    '    }\n' +
    '  }\n' +
    '}';
  const explanation =
    props.instance.authMode === 'oauth'
      ? 'This endpoint uses OAuth protected-resource discovery. Use an MCP client that supports OAuth; do not paste a static credential.'
      : props.instance.authMode === 'none'
        ? 'This endpoint has no application authentication and is intentionally loopback-only.'
        : `Paste the ${props.instance.authMode === 'api-key' ? 'API key' : 'bearer token'} shown at provision/rotation time.`;
  return (
    <Modal open title={`Connect a client — ${props.instance.id}`} onClose={props.onClose}>
      <div className="grid gap-3">
        {props.publicUrl ? <Banner tone="info">A Cloudflare tunnel is live; this snippet uses its public URL. Local endpoint: <Code>{localEndpoint}</Code></Banner> : <Banner tone="info">Loopback endpoint for clients on this machine.</Banner>}
        <p className="m-0 text-xs text-muted">{explanation}</p>
        {props.instance.openAiTunnel ? <Banner tone="info">For ChatGPT Secure MCP Tunnel, connect with tunnel ID <Code>{props.instance.openAiTunnel.tunnelId}</Code> rather than this local URL.</Banner> : null}
        <pre className="overflow-auto rounded-lg border border-border-soft bg-[#0b1119] p-3 font-mono text-[11px] leading-relaxed">{snippet}</pre>
        <div className="flex justify-end gap-2"><Button size="sm" onClick={() => navigator.clipboard.writeText(snippet).then(() => toast('success', 'Client config copied')).catch(() => undefined)}><Copy size={13} aria-hidden /> Copy config</Button><Button size="sm" variant="ghost" onClick={props.onClose}>Done</Button></div>
      </div>
    </Modal>
  );
}
