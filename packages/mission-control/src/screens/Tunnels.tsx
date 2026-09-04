import { useState } from 'react';
import { Cloud, MessageSquare, Share2 } from 'lucide-react';
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
  SkeletonRows,
  StatePill,
  useToast,
} from '../ui';
import type { CloudflareStatus, FleetInstance, OpenAiTunnelStatus, TunnelRecord } from '../types';

export function TunnelsScreen() {
  const toast = useToast();
  const tunnels = useApi<{ tunnels: TunnelRecord[] }>('/tunnels');
  const cf = useApi<CloudflareStatus>('/cloudflare/status');
  const fleet = useApi<{ instances: FleetInstance[] }>('/fleet');
  const action = useAction();
  const [port, setPort] = useState('');
  const [cfToken, setCfToken] = useState('');
  const [cfAccount, setCfAccount] = useState('');
  const [cfDomain, setCfDomain] = useState('');
  const [cfBusy, setCfBusy] = useState(false);
  const [cfError, setCfError] = useState<string | null>(null);
  const gpt = useApi<OpenAiTunnelStatus>('/openai-tunnel/status');
  const [gptTunnelId, setGptTunnelId] = useState('');
  const [gptKeyEnv, setGptKeyEnv] = useState('CONTROL_PLANE_API_KEY');
  const [gptKey, setGptKey] = useState('');
  const [gptBusy, setGptBusy] = useState(false);
  const [gptError, setGptError] = useState<string | null>(null);
  const [gptVerify, setGptVerify] = useState<{ ok: boolean; text: string } | null>(null);

  const start = async () => {
    const ok = await action.run('/tunnels', { targetPort: Number(port) });
    if (ok) {
      setPort('');
      tunnels.reload();
      toast('success', 'Tunnel starting — public URL appears once assigned');
    }
  };

  const link = async () => {
    setCfBusy(true);
    setCfError(null);
    try {
      await api('/cloudflare/config', {
        method: 'POST',
        body: { apiToken: cfToken.trim(), accountId: cfAccount.trim(), domain: cfDomain.trim() },
      });
      setCfToken('');
      setCfAccount('');
      setCfDomain('');
      cf.reload();
      toast('success', 'Cloudflare account linked — named tunnels unlocked');
    } catch (e) {
      setCfError(e instanceof Error ? e.message : String(e));
    } finally {
      setCfBusy(false);
    }
  };

  const unlink = async () => {
    setCfBusy(true);
    setCfError(null);
    try {
      await api('/cloudflare/config', { method: 'DELETE' });
      cf.reload();
      toast('success', 'Cloudflare account unlinked');
    } catch (e) {
      setCfError(e instanceof Error ? e.message : String(e));
    } finally {
      setCfBusy(false);
    }
  };

  const saveGpt = async () => {
    setGptBusy(true);
    setGptError(null);
    setGptVerify(null);
    try {
      await api('/openai-tunnel/config', {
        method: 'POST',
        body: {
          tunnelId: gptTunnelId.trim(),
          apiKeyEnv: gptKeyEnv.trim() || 'CONTROL_PLANE_API_KEY',
          ...(gptKey.trim() ? { apiKey: gptKey.trim() } : {}),
        },
      });
      setGptTunnelId('');
      setGptKey('');
      gpt.reload();
      toast('success', 'ChatGPT tunnel config saved');
    } catch (e) {
      setGptError(e instanceof Error ? e.message : String(e));
    } finally {
      setGptBusy(false);
    }
  };

  // Verify probes the OpenAI API with the pasted key (or the saved/env one)
  // without persisting anything — answers "is this key actually valid?".
  const verifyGpt = async () => {
    setGptBusy(true);
    setGptVerify(null);
    try {
      const result = await api<{ ok: boolean; scope?: string; message?: string }>(
        '/openai-tunnel/verify',
        { method: 'POST', body: gptKey.trim() ? { apiKey: gptKey.trim() } : {} },
      );
      setGptVerify({ ok: true, text: result.message ?? 'Key authenticated with OpenAI' });
    } catch (e) {
      setGptVerify({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setGptBusy(false);
    }
  };

  const unlinkGpt = async () => {
    setGptBusy(true);
    setGptError(null);
    try {
      await api('/openai-tunnel/config', { method: 'DELETE' });
      gpt.reload();
      toast('success', 'ChatGPT tunnel config unlinked');
    } catch (e) {
      setGptError(e instanceof Error ? e.message : String(e));
    } finally {
      setGptBusy(false);
    }
  };

  const startGpt = async () => {
    const ok = await action.run('/openai-tunnel/start');
    if (ok) {
      gpt.reload();
      toast('success', 'ChatGPT tunnel supervisor started');
    }
  };

  const stopGpt = async () => {
    const ok = await action.run('/openai-tunnel/stop');
    if (ok) {
      gpt.reload();
      toast('success', 'ChatGPT tunnel supervisor stopped');
    }
  };

  const records = (tunnels.data && tunnels.data.tunnels) || [];
  const cfData = cf.data;
  const runningPorts = ((fleet.data && fleet.data.instances) || [])
    .filter((i) => i.state === 'running')
    .map((i) => i.port);
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Tunnels"
        subtitle="Expose a local port publicly — quick trycloudflare URLs, or stable subdomains on your own domain once Cloudflare is linked."
      />

      <Banner tone="warn">
        Tunnels expose a local port <strong>publicly</strong>. Only expose token-protected endpoints;
        starting one is a HIGH-risk, policy-gated action.
      </Banner>

      {cfData && cfData.configured ? (
        <Card title="Cloudflare account" hint="named tunnels + DNS enabled">
          <div className="grid gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
              <span className="text-muted">Domain</span>
              <Code>{cfData.domain}</Code>
              <span className="text-muted">Account</span>
              <Code>{cfData.accountId}</Code>
              <span className="text-muted">Token</span>
              <Code>{cfData.tokenPreview}</Code>
            </div>
            <p className="text-xs text-muted">
              Fleet → Start tunnel now offers a <strong>named tunnel</strong>: pick a subdomain like{' '}
              <Code>mcp1.{cfData.domain}</Code> and FolderForge creates the Cloudflare tunnel, the DNS
              CNAME, and starts cloudflared — the URL is stable across restarts.
            </p>
            <div>
              <Button size="sm" variant="danger" disabled={cfBusy} busy={cfBusy} onClick={() => void unlink()}>
                Unlink account
              </Button>
            </div>
            <ErrorNote message={cfError} />
          </div>
        </Card>
      ) : (
        <Card title="Link Cloudflare account" hint="optional — unlocks stable subdomains + DNS">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="API token" className="w-72">
              <Input
                type="password"
                value={cfToken}
                onChange={(e) => setCfToken(e.target.value)}
                placeholder="Token with Tunnel:Edit + DNS:Edit"
                aria-label="Cloudflare API token"
              />
            </Field>
            <Field label="Account ID" className="w-64">
              <Input
                value={cfAccount}
                onChange={(e) => setCfAccount(e.target.value)}
                placeholder="dash.cloudflare.com → account ID"
                aria-label="Cloudflare account ID"
              />
            </Field>
            <Field label="Domain" className="w-56">
              <Input
                value={cfDomain}
                onChange={(e) => setCfDomain(e.target.value)}
                placeholder="example.com"
                aria-label="Cloudflare zone domain"
              />
            </Field>
            <Button
              variant="primary"
              disabled={!cfToken.trim() || !cfAccount.trim() || !cfDomain.trim() || cfBusy}
              busy={cfBusy}
              onClick={() => void link()}
            >
              <Cloud size={13} aria-hidden /> Link account
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted">
            The token is verified against the Cloudflare API, then stored locally at{' '}
            <Code>.folderforge/cloudflare.json</Code> (0600) — never logged, never returned by the API.
          </p>
          <ErrorNote message={cfError ?? cf.error} />
        </Card>
      )}

      {gpt.data && gpt.data.configured ? (
        <Card title="ChatGPT tunnel" hint="OpenAI Secure MCP Tunnel — no Cloudflare involved">
          <div className="grid gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
              <span className="text-muted">Tunnel</span>
              <Code>{gpt.data.tunnelId}</Code>
              <span className="text-muted">API key env</span>
              <Code>{gpt.data.apiKeyEnv}</Code>
              <span className="text-muted">Key in env</span>
              <StatePill value={gpt.data.apiKeyPresent ? 'set' : 'missing'} />
              {gpt.data.apiKeyStored ? (
                <>
                  <span className="text-muted">Stored key</span>
                  <Code>{gpt.data.keyPreview}</Code>
                </>
              ) : null}
              <span className="text-muted">Supervisor</span>
              <StatePill value={gpt.data.running ? 'running' : 'stopped'} />
            </div>
            <p className="text-xs text-muted">
              Starts the OpenAI tunnel supervisor for this control-plane project (loopback MCP server +
              the official tunnel client). Export the key (<Code>{gpt.data.apiKeyEnv}</Code>) into the
              Mission Control process before starting the plane — only the variable name is stored.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {gpt.data.running ? (
                <Button size="sm" variant="danger" disabled={action.busy} busy={action.busy} onClick={() => void stopGpt()}>
                  Stop tunnel
                </Button>
              ) : (
                <Button size="sm" variant="primary" disabled={action.busy || !gpt.data.apiKeyPresent} busy={action.busy} onClick={() => void startGpt()}>
                  Start tunnel
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={gptBusy} busy={gptBusy} onClick={() => void verifyGpt()}>
                Verify key
              </Button>
              <Button size="sm" variant="ghost" disabled={gptBusy} busy={gptBusy} onClick={() => void unlinkGpt()}>
                Unlink config
              </Button>
            </div>
            {gptVerify?.ok ? (
              <p className="text-xs text-green">{gptVerify.text}</p>
            ) : (
              <ErrorNote message={gptVerify?.text ?? null} />
            )}
            <ErrorNote message={gptError ?? action.error} />
          </div>
        </Card>
      ) : (
        <Card title="ChatGPT tunnel (OpenAI)" hint="GPT alternative to Cloudflare — saved locally">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Tunnel ID" className="w-80">
              <Input
                value={gptTunnelId}
                onChange={(e) => setGptTunnelId(e.target.value)}
                placeholder="tunnel_<32 hex> — platform.openai.com → tunnels"
                aria-label="OpenAI tunnel ID"
              />
            </Field>
            <Field label="API key env var" className="w-64">
              <Input
                value={gptKeyEnv}
                onChange={(e) => setGptKeyEnv(e.target.value)}
                placeholder="CONTROL_PLANE_API_KEY"
                aria-label="OpenAI API key environment variable name"
              />
            </Field>
            <Field label="API key (optional)" className="w-72">
              <Input
                type="password"
                value={gptKey}
                onChange={(e) => setGptKey(e.target.value)}
                placeholder="sk-... — stored 0600, or just export the env var"
                aria-label="OpenAI API key value (stored locally, optional)"
              />
            </Field>
            <Button
              variant="primary"
              disabled={!gptTunnelId.trim() || gptBusy}
              busy={gptBusy}
              onClick={() => void saveGpt()}
            >
              <MessageSquare size={13} aria-hidden /> Save config
            </Button>
            <Button
              variant="ghost"
              disabled={!gptKey.trim() || gptBusy}
              busy={gptBusy}
              onClick={() => void verifyGpt()}
            >
              Verify key
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Saved at <Code>.folderforge/openai-tunnel-config.json</Code> (0600). Paste the key itself
            (stored like the Cloudflare token, later shown only as …last4) or just export the env var
            before starting the plane — your choice. Verify probes the OpenAI API without saving.
          </p>
          {gptVerify?.ok ? (
            <p className="mt-2 text-xs text-green">{gptVerify.text}</p>
          ) : (
            <ErrorNote message={gptVerify?.text ?? null} />
          )}
          <ErrorNote message={gptError ?? gpt.error} />
        </Card>
      )}

      <Card title="Start a quick tunnel">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Local port" className="w-56">
            <Input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="e.g. 7410"
              inputMode="numeric"
              aria-label="Local port to expose publicly"
            />
          </Field>
          <Button variant="primary" disabled={!port.trim() || action.busy} busy={action.busy} onClick={() => void start()}>
            Start tunnel
          </Button>
        </div>
        {runningPorts.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span>Running instances:</span>
            {runningPorts.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPort(String(p))}
                className="rounded-md border border-border px-2 py-0.5 font-mono text-[11px] text-fg hover:bg-white/5 transition-colors"
              >
                :{p}
              </button>
            ))}
          </div>
        ) : null}
        <ErrorNote message={action.error ?? tunnels.error} />
      </Card>

      <Card title="Tunnels" hint={records.length + ' tracked'}>
        {tunnels.loading ? (
          <SkeletonRows rows={2} />
        ) : (
          <DataTable
            head={['Tunnel', 'Kind', 'Target', 'Public URL', 'State', 'Action']}
            rows={records.map((t) => [
              <Code key="id">{t.id}</Code>,
              t.kind === 'named' ? (
                <span key="k" className="text-xs font-medium text-green">named · {t.hostname}</span>
              ) : (
                <span key="k" className="text-xs text-muted">quick</span>
              ),
              <Code key="t">{t.targetUrl}</Code>,
              t.publicUrl ? (
                <a key="u" href={t.publicUrl} target="_blank" rel="noreferrer" className="text-blue hover:underline font-mono text-xs break-all">
                  {t.publicUrl}
                </a>
              ) : (
                <span key="u" className="text-muted">—</span>
              ),
              <StatePill key="s" value={t.state} />,
              t.state === 'running' || t.state === 'starting' ? (
                <div key="a" className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run('/tunnels/' + encodeURIComponent(t.id) + '/stop').then((ok) => {
                        if (ok) {
                          tunnels.reload();
                          toast('success', t.id + ' stopped');
                        }
                      })
                    }
                  >
                    Stop
                  </Button>
                  {t.kind === 'named' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={action.busy}
                      title="Also deletes the DNS record and the Cloudflare tunnel"
                      onClick={() =>
                        void action.run('/tunnels/' + encodeURIComponent(t.id) + '/stop', { cleanup: true }).then((ok) => {
                          if (ok) {
                            tunnels.reload();
                            toast('success', t.id + ' stopped + DNS/tunnel deleted');
                          }
                        })
                      }
                    >
                      Stop + delete DNS
                    </Button>
                  ) : null}
                </div>
              ) : (
                <span key="a" className="text-muted">—</span>
              ),
            ])}
            empty={
              <EmptyState
                icon={<Share2 size={22} />}
                title="No tunnels running"
                hint="Start one above, or use Fleet → Start tunnel on a running MCP instance."
              />
            }
          />
        )}
      </Card>
    </div>
  );
}
