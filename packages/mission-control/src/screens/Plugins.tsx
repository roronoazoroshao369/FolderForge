import { Puzzle } from 'lucide-react';
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
  StatePill,
  useToast,
} from '../ui';
import type { MarketplaceEntry, PluginRecord } from '../types';

export function PluginsScreen() {
  const toast = useToast();
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
    <div className="grid gap-6">
      <PageHeader title="Plugins & Marketplace" subtitle="Local plugins and the verified marketplace index." />

      <Card title="Installed plugins" hint={`${installed.length} installed`}>
        {plugins.loading ? (
          <SkeletonRows rows={2} />
        ) : (
          <DataTable
            head={['Plugin', 'Version', 'State', 'Action']}
            rows={installed.map((p) => [
              <Code key="id">{p.id}</Code>,
              <Code key="v">{p.version ?? '—'}</Code>,
              <StatePill key="s" value={p.enabled ? 'enabled' : 'disabled'} />,
              <Button
                key="a"
                size="sm"
                variant={p.enabled ? 'danger' : 'primary'}
                disabled={action.busy}
                onClick={() =>
                  void action
                    .run(`/plugins/${encodeURIComponent(p.id)}/${p.enabled ? 'disable' : 'enable'}`)
                    .then((ok) => {
                      if (ok) {
                        plugins.reload();
                        toast('success', `${p.id} ${p.enabled ? 'disabled' : 'enabled'}`);
                      }
                    })
                }
              >
                {p.enabled ? 'Disable' : 'Enable'}
              </Button>,
            ])}
            empty={<EmptyState icon={<Puzzle size={22} />} title="No plugins installed" />}
          />
        )}
        <ErrorNote message={action.error ?? plugins.error} />
      </Card>

      <Card title="Marketplace index" hint="verified packages">
        {market.loading ? (
          <SkeletonRows rows={2} />
        ) : (
          <DataTable
            head={['Package', 'Publisher', 'Version']}
            rows={entries.map((e) => [
              <Code key="id">{e.id ?? e.name ?? '—'}</Code>,
              <Code key="p">{e.publisher ?? '—'}</Code>,
              <Code key="v">{e.version ?? '—'}</Code>,
            ])}
            empty={
              <EmptyState
                icon={<Puzzle size={22} />}
                title="Marketplace index is empty"
                hint="Sync an index to browse verified packages."
              />
            }
          />
        )}
        <ErrorNote message={market.error} />
      </Card>
    </div>
  );
}
