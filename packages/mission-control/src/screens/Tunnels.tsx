import { useState } from 'react';
import { Share2 } from 'lucide-react';
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
import type { TunnelRecord } from '../types';

export function TunnelsScreen() {
  const toast = useToast();
  const tunnels = useApi<{ tunnels: TunnelRecord[] }>('/tunnels');
  const action = useAction();
  const [port, setPort] = useState('');

  const start = async () => {
    const ok = await action.run('/tunnels', { targetPort: Number(port) });
    if (ok) {
      setPort('');
      tunnels.reload();
      toast('success', 'Tunnel starting — public URL appears once assigned');
    }
  };

  const records = tunnels.data?.tunnels ?? [];
  return (
    <div className="grid gap-6">
      <PageHeader title="Tunnels" subtitle="Expose a local port on a public Cloudflare quick-tunnel URL." />

      <Banner tone="warn">
        Quick tunnels expose a local port on a <strong>public</strong> trycloudflare URL. Only expose
        token-protected endpoints; starting a tunnel is a HIGH-risk, policy-gated action.
      </Banner>

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
        <ErrorNote message={action.error ?? tunnels.error} />
      </Card>

      <Card title="Tunnels" hint={`${records.length} tracked`}>
        {tunnels.loading ? (
          <SkeletonRows rows={2} />
        ) : (
          <DataTable
            head={['Tunnel', 'Target', 'Public URL', 'State', 'Action']}
            rows={records.map((t) => [
              <Code key="id">{t.id}</Code>,
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
                <Button
                  key="a"
                  size="sm"
                  variant="danger"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(`/tunnels/${encodeURIComponent(t.id)}/stop`).then((ok) => {
                      if (ok) {
                        tunnels.reload();
                        toast('success', `${t.id} stopped`);
                      }
                    })
                  }
                >
                  Stop
                </Button>
              ) : (
                <span key="a" className="text-muted">—</span>
              ),
            ])}
            empty={
              <EmptyState
                icon={<Share2 size={22} />}
                title="No tunnels running"
                hint="Start one above to expose a token-protected port on a public URL."
              />
            }
          />
        )}
      </Card>
    </div>
  );
}
