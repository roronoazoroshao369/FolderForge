import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, getToken, setToken } from './api';

/* ---------- data shapes (mirror the governed dashboard API) ---------- */

interface FleetInstance {
  id: string;
  name: string;
  projectPath: string;
  port: number;
  toolsPreset: string;
  policyMode: string;
  state: string;
  autoRestart?: boolean;
  lastError?: string;
}

interface TunnelRecord {
  id: string;
  targetPort: number;
  targetUrl: string;
  publicUrl?: string;
  state: string;
  lastError?: string;
}

interface WorkspaceRecord {
  projectRoot?: string;
  path?: string;
  root?: string;
  current?: boolean;
  active?: boolean;
  isCurrent?: boolean;
}

interface PluginRecord {
  id: string;
  version?: string;
  enabled?: boolean;
}

interface MarketplaceEntry {
  id?: string;
  name?: string;
  publisher?: string;
  version?: string;
}

interface ApprovalRecord {
  id: string;
  tool?: string;
  toolName?: string;
  risk?: string;
  status?: string;
  summary?: string;
  reason?: string;
}

interface AuditRecord {
  timestamp?: string;
  time?: string;
  type?: string;
  summary?: string;
  status?: string;
  risk?: string;
}

interface StatusSnapshot {
  policy?: { mode?: string };
  workspace?: { projectRoot?: string };
  server?: { version?: string };
}

type Page =
  | 'overview'
  | 'fleet'
  | 'tunnels'
  | 'workspaces'
  | 'plugins'
  | 'approvals'
  | 'audit'
  | 'settings';

/* ---------- hooks ---------- */

function useApi<T>(path: string, refreshMs = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let alive = true;
    const load = () => {
      api<T>(path)
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError(null);
        })
        .catch((e: unknown) => {
          if (alive) setError(e instanceof Error ? e.message : String(e));
        });
    };
    load();
    const timer = setInterval(load, refreshMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path, tick, refreshMs]);
  return { data, error, reload };
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (path: string, body?: unknown): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST', body });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

/* ---------- shared UI ---------- */

function Card(props: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{props.title}</h2>
        {props.hint ? <span className="hint">{props.hint}</span> : null}
      </header>
      <div className="card-body">{props.children}</div>
    </section>
  );
}

function Table(props: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (props.rows.length === 0) return <div className="empty">{props.empty}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {props.head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((cells, i) => (
            <tr key={i}>
              {cells.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ErrorNote(props: { message: string | null }) {
  if (!props.message) return null;
  return <div className="error-note">{props.message}</div>;
}

function StatePill(props: { value: string }) {
  const v = props.value || '-';
  return <span className={`pill state-${v}`}>{v}</span>;
}

/* ---------- screens ---------- */

function OverviewScreen() {
  const status = useApi<StatusSnapshot>('/status');
  const fleet = useApi<{ instances: FleetInstance[] }>('/fleet');
  const tunnels = useApi<{ tunnels: TunnelRecord[] }>('/tunnels');
  const approvals = useApi<{ pending?: ApprovalRecord[] }>('/approvals');
  const instances = fleet.data?.instances ?? [];
  const running = instances.filter((i) => i.state === 'running').length;
  const liveTunnels = (tunnels.data?.tunnels ?? []).filter((t) => t.state === 'running').length;
  const pending = approvals.data?.pending?.length ?? 0;
  return (
    <div className="grid">
      <Card title="Control plane" hint="live">
        <div className="metric-row">
          <div className="metric">
            <strong>{running}</strong>
            <span>instances running</span>
          </div>
          <div className="metric">
            <strong>{instances.length}</strong>
            <span>folders provisioned</span>
          </div>
          <div className="metric">
            <strong>{liveTunnels}</strong>
            <span>public tunnels</span>
          </div>
          <div className="metric">
            <strong>{pending}</strong>
            <span>pending approvals</span>
          </div>
        </div>
        <div className="kv">
          <span>Policy mode</span>
          <code>{status.data?.policy?.mode ?? '-'}</code>
        </div>
        <div className="kv">
          <span>Workspace</span>
          <code>{status.data?.workspace?.projectRoot ?? '-'}</code>
        </div>
        <ErrorNote message={status.error} />
      </Card>
      <Card title="Fleet quick view" hint="per-folder MCP servers">
        <Table
          head={['Instance', 'Port', 'State']}
          rows={instances.map((i) => [
            <code key="id">{i.id}</code>,
            <code key="p">{i.port}</code>,
            <StatePill key="s" value={i.state} />,
          ])}
          empty="No instances yet — provision a folder from the Fleet screen."
        />
      </Card>
    </div>
  );
}

function FleetScreen() {
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
      }>('/fleet', { method: 'POST', body: { projectPath: path, toolsPreset: preset, policyMode: policy } });
      if (result.ok && result.data?.id && result.data.token) {
        setIssued({ id: result.data.id, token: result.data.token });
        setPath('');
        fleet.reload();
      } else {
        setFormError(result.error ?? 'Provision failed.');
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  const lifecycle = (id: string, actionName: string, body?: unknown) =>
    void action.run(`/fleet/${encodeURIComponent(id)}/${actionName}`, body).then((ok) => {
      if (ok) fleet.reload();
    });

  const instances = fleet.data?.instances ?? [];
  return (
    <div className="stack">
      <Card title="Provision a folder" hint="one governed MCP server per folder">
        <div className="form-row">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/absolute/path/to/folder"
            aria-label="Folder path to provision"
          />
          <select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Tool preset">
            {['vibe', 'vibe-lite', 'readonly', 'full', 'godot'].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select value={policy} onChange={(e) => setPolicy(e.target.value)} aria-label="Policy mode">
            {['readonly', 'safe', 'dev', 'danger'].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button className="primary" disabled={!path.trim() || action.busy} onClick={() => void provision()}>
            Provision
          </button>
        </div>
        <ErrorNote message={formError ?? fleet.error} />
        {issued ? (
          <div className="token-banner">
            <div>
              <strong>{issued.id}</strong> provisioned. Bearer token (shown exactly once):
            </div>
            <code>{issued.token}</code>
            <div className="actions">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(issued.token).catch(() => undefined);
                }}
              >
                Copy
              </button>
              <button onClick={() => setIssued(null)}>Done</button>
            </div>
          </div>
        ) : null}
      </Card>
      <Card title="Instances" hint={`${instances.length} provisioned`}>
        <Table
          head={['Instance', 'Folder', 'Port', 'Preset', 'Policy', 'State', 'Auto-restart', 'Actions']}
          rows={instances.map((i) => [
            <code key="id">{i.id}</code>,
            <span key="f" className="path" title={i.projectPath}>
              {i.name}
            </span>,
            <code key="p">{i.port}</code>,
            <code key="t">{i.toolsPreset}</code>,
            <code key="m">{i.policyMode}</code>,
            <StatePill key="s" value={i.state} />,
            <button
              key="ar"
              disabled={action.busy}
              onClick={() => lifecycle(i.id, 'auto-restart', { enabled: !i.autoRestart })}
            >
              {i.autoRestart ? 'on' : 'off'}
            </button>,
            <span key="a" className="actions">
              {i.state === 'running' ? (
                <>
                  <button disabled={action.busy} onClick={() => lifecycle(i.id, 'stop')}>
                    Stop
                  </button>
                  <button disabled={action.busy} onClick={() => lifecycle(i.id, 'restart')}>
                    Restart
                  </button>
                </>
              ) : (
                <button
                  className="primary"
                  disabled={action.busy || i.state === 'starting'}
                  onClick={() => lifecycle(i.id, 'start')}
                >
                  Start
                </button>
              )}
            </span>,
          ])}
          empty="Nothing provisioned yet."
        />
        <ErrorNote message={action.error} />
        <div className="hint">
          Instance endpoint: http://127.0.0.1:PORT/mcp with its bearer token.
        </div>
      </Card>
    </div>
  );
}

function TunnelsScreen() {
  const tunnels = useApi<{ tunnels: TunnelRecord[] }>('/tunnels');
  const action = useAction();
  const [port, setPort] = useState('');
  const start = async () => {
    if (await action.run('/tunnels', { targetPort: Number(port) })) {
      setPort('');
      tunnels.reload();
    }
  };
  const records = tunnels.data?.tunnels ?? [];
  return (
    <div className="stack">
      <Card title="Start a quick tunnel" hint="HIGH risk · policy-gated">
        <div className="warn-banner">
          Quick tunnels expose a local port on a PUBLIC trycloudflare URL. Only expose
          token-protected endpoints.
        </div>
        <div className="form-row">
          <input
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="Local port (e.g. 7410)"
            aria-label="Local port to expose publicly"
            inputMode="numeric"
          />
          <button className="primary" disabled={!port.trim() || action.busy} onClick={() => void start()}>
            Start tunnel
          </button>
        </div>
        <ErrorNote message={action.error ?? tunnels.error} />
      </Card>
      <Card title="Tunnels" hint={`${records.length} tracked`}>
        <Table
          head={['Tunnel', 'Target', 'Public URL', 'State', 'Action']}
          rows={records.map((t) => [
            <code key="id">{t.id}</code>,
            <code key="t">{t.targetUrl}</code>,
            t.publicUrl ? (
              <a key="u" href={t.publicUrl} target="_blank" rel="noreferrer">
                {t.publicUrl}
              </a>
            ) : (
              <span key="u">-</span>
            ),
            <StatePill key="s" value={t.state} />,
            t.state === 'running' || t.state === 'starting' ? (
              <button
                key="a"
                className="danger"
                disabled={action.busy}
                onClick={() =>
                  void action.run(`/tunnels/${encodeURIComponent(t.id)}/stop`).then((ok) => {
                    if (ok) tunnels.reload();
                  })
                }
              >
                Stop
              </button>
            ) : (
              <span key="a">-</span>
            ),
          ])}
          empty="No tunnels running."
        />
      </Card>
    </div>
  );
}

function WorkspacesScreen() {
  const ws = useApi<{ workspaces: WorkspaceRecord[] }>('/workspaces');
  const action = useAction();
  const rows = (ws.data?.workspaces ?? []).map((w) => {
    const path = w.projectRoot ?? w.path ?? w.root ?? '';
    const current = Boolean(w.current ?? w.active ?? w.isCurrent);
    return [
      <code key="p" className="path">
        {path}
      </code>,
      current ? (
        <span key="s" className="pill pass">
          current
        </span>
      ) : (
        <span key="s" className="pill">
          registered
        </span>
      ),
      current ? (
        <span key="a">-</span>
      ) : (
        <button
          key="a"
          className="primary"
          disabled={action.busy}
          onClick={() =>
            void action.run('/workspaces/switch', { path }).then((ok) => {
              if (ok) ws.reload();
            })
          }
        >
          Switch
        </button>
      ),
    ];
  });
  return (
    <div className="stack">
      <Card title="Activated workspaces" hint="path-less tool calls run in the current one">
        <Table head={['Workspace', 'Status', 'Action']} rows={rows} empty="No workspaces registered." />
        <ErrorNote message={action.error ?? ws.error} />
      </Card>
    </div>
  );
}

function PluginsScreen() {
  const plugins = useApi<{ plugins: PluginRecord[] }>('/plugins');
  const market = useApi<{
    plugins?: MarketplaceEntry[];
    results?: MarketplaceEntry[];
    entries?: MarketplaceEntry[];
  }>('/marketplace');
  const action = useAction();
  const installed = plugins.data?.plugins ?? [];
  const entries = market.data?.plugins ?? market.data?.results ?? market.data?.entries ?? [];
  return (
    <div className="stack">
      <Card title="Installed plugins" hint={`${installed.length} installed`}>
        <Table
          head={['Plugin', 'Version', 'State', 'Action']}
          rows={installed.map((p) => [
            <code key="id">{p.id}</code>,
            <code key="v">{p.version ?? '-'}</code>,
            <StatePill key="s" value={p.enabled ? 'enabled' : 'disabled'} />,
            <button
              key="a"
              className={p.enabled ? 'danger' : 'primary'}
              disabled={action.busy}
              onClick={() =>
                void action
                  .run(`/plugins/${encodeURIComponent(p.id)}/${p.enabled ? 'disable' : 'enable'}`)
                  .then((ok) => {
                    if (ok) plugins.reload();
                  })
              }
            >
              {p.enabled ? 'Disable' : 'Enable'}
            </button>,
          ])}
          empty="No plugins installed."
        />
        <ErrorNote message={action.error ?? plugins.error} />
      </Card>
      <Card title="Marketplace index" hint="verified packages">
        <Table
          head={['Package', 'Publisher', 'Version']}
          rows={entries.map((e) => [
            <code key="id">{e.id ?? e.name ?? '-'}</code>,
            <code key="p">{e.publisher ?? '-'}</code>,
            <code key="v">{e.version ?? '-'}</code>,
          ])}
          empty="Marketplace index is empty. Sync an index to browse verified packages."
        />
        <ErrorNote message={market.error} />
      </Card>
    </div>
  );
}

function ApprovalsScreen() {
  const approvals = useApi<{ pending?: ApprovalRecord[]; approvals?: ApprovalRecord[] }>('/approvals');
  const action = useAction();
  const list = approvals.data?.pending ?? approvals.data?.approvals ?? [];
  const decide = (id: string, decision: 'approve' | 'deny') =>
    void action.run(`/approvals/${encodeURIComponent(id)}/${decision}`, decision === 'approve' ? { scope: 'once' } : undefined).then((ok) => {
      if (ok) approvals.reload();
    });
  return (
    <div className="stack">
      <Card title="Approval requests" hint="HIGH/CRITICAL tools wait here under safe policy">
        <Table
          head={['Request', 'Tool', 'Risk', 'Status', 'Decision']}
          rows={list.map((a) => [
            <code key="id">{a.id}</code>,
            <code key="t">{a.tool ?? a.toolName ?? '-'}</code>,
            <span key="r" className="pill">
              {a.risk ?? '-'}
            </span>,
            <span key="s">{a.status ?? 'pending'}</span>,
            a.status === undefined || a.status === 'pending' ? (
              <span key="a" className="actions">
                <button className="primary" disabled={action.busy} onClick={() => decide(a.id, 'approve')}>
                  Approve
                </button>
                <button className="danger" disabled={action.busy} onClick={() => decide(a.id, 'deny')}>
                  Deny
                </button>
              </span>
            ) : (
              <span key="a">-</span>
            ),
          ])}
          empty="No pending approvals."
        />
        <ErrorNote message={action.error ?? approvals.error} />
      </Card>
    </div>
  );
}

function AuditScreen() {
  const audit = useApi<unknown>('/audit?limit=50');
  const events: AuditRecord[] = (() => {
    const d = audit.data;
    if (Array.isArray(d)) return d as AuditRecord[];
    if (d && typeof d === 'object') {
      const obj = d as { events?: AuditRecord[]; audit?: AuditRecord[] };
      return obj.events ?? obj.audit ?? [];
    }
    return [];
  })();
  return (
    <div className="stack">
      <Card title="Audit log" hint="latest 50 events">
        <Table
          head={['Time', 'Type', 'Summary', 'Status']}
          rows={events.map((e, i) => [
            <code key={`t${i}`}>{e.timestamp ?? e.time ?? '-'}</code>,
            <code key={`y${i}`}>{e.type ?? '-'}</code>,
            <span key={`s${i}`} className="path" title={e.summary}>
              {e.summary ?? '-'}
            </span>,
            <span key={`x${i}`}>{e.status ?? e.risk ?? '-'}</span>,
          ])}
          empty="No audit events yet."
        />
        <ErrorNote message={audit.error} />
      </Card>
    </div>
  );
}

function SettingsScreen() {
  const status = useApi<StatusSnapshot>('/status');
  const action = useAction();
  const [token, setTokenValue] = useState(getToken());
  const [mode, setMode] = useState('dev');
  useEffect(() => {
    const current = status.data?.policy?.mode;
    if (current) setMode(current);
  }, [status.data]);
  return (
    <div className="stack">
      <Card title="Dashboard bearer token" hint="stored per browser (localStorage)">
        <div className="form-row">
          <input
            type="password"
            value={token}
            onChange={(e) => setTokenValue(e.target.value)}
            placeholder="Bearer token"
            aria-label="Dashboard bearer token"
          />
          <button
            className="primary"
            onClick={() => {
              setToken(token.trim());
              location.reload();
            }}
          >
            Save &amp; reload
          </button>
          <button
            onClick={() => {
              setToken('');
              location.reload();
            }}
          >
            Clear
          </button>
        </div>
        <div className="hint">
          Loopback binds skip auth; the token is required when the dashboard is reached
          through a tunnel or a non-loopback bind.
        </div>
      </Card>
      <Card title="Policy mode" hint="admin only">
        <div className="form-row">
          <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Policy mode">
            {['readonly', 'safe', 'dev', 'danger'].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            className="primary"
            disabled={action.busy}
            onClick={() =>
              void action.run('/policy/mode', { mode }).then((ok) => {
                if (ok) status.reload();
              })
            }
          >
            Apply
          </button>
        </div>
        <ErrorNote message={action.error} />
      </Card>
    </div>
  );
}

/* ---------- shell ---------- */

const NAV: Array<{ id: Page; label: string; icon: string }> = [
  { id: 'overview', label: 'Overview', icon: '⬢' },
  { id: 'fleet', label: 'Fleet', icon: '⛁' },
  { id: 'tunnels', label: 'Tunnels', icon: '⇄' },
  { id: 'workspaces', label: 'Workspaces', icon: '▣' },
  { id: 'plugins', label: 'Plugins', icon: '✦' },
  { id: 'approvals', label: 'Approvals', icon: '✓' },
  { id: 'audit', label: 'Audit', icon: '≡' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

export function App() {
  const [page, setPage] = useState<Page>('overview');
  const active = NAV.find((n) => n.id === page) ?? NAV[0];
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">FF</span>
          <div>
            <strong>FolderForge</strong>
            <span>Mission Control</span>
          </div>
        </div>
        <nav>
          {NAV.map((item) => (
            <button
              key={item.id}
              className={item.id === page ? 'nav-item active' : 'nav-item'}
              onClick={() => setPage(item.id)}
            >
              <span aria-hidden>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">governed by policy + audit</div>
      </aside>
      <main className="content">
        <header className="topbar">
          <h1>{active.label}</h1>
          <button onClick={() => setPage('settings')}>{getToken() ? 'Token set' : 'Set token'}</button>
        </header>
        {page === 'overview' && <OverviewScreen />}
        {page === 'fleet' && <FleetScreen />}
        {page === 'tunnels' && <TunnelsScreen />}
        {page === 'workspaces' && <WorkspacesScreen />}
        {page === 'plugins' && <PluginsScreen />}
        {page === 'approvals' && <ApprovalsScreen />}
        {page === 'audit' && <AuditScreen />}
        {page === 'settings' && <SettingsScreen />}
      </main>
    </div>
  );
}
