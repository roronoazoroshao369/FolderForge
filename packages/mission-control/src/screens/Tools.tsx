import { useMemo, useState } from 'react';
import { Wrench } from 'lucide-react';
import { useApi } from '../hooks';
import { Card, Code, EmptyState, ErrorNote, PageHeader, RiskBadge, SearchInput, SkeletonRows } from '../ui';
import type { ToolRecord, ToolsCatalog } from '../types';

export function ToolsScreen() {
  const catalog = useApi<ToolsCatalog>('/tools');
  const [filter, setFilter] = useState('');
  const tools = useMemo(() => catalog.data?.tools ?? [], [catalog.data]);
  const q = filter.trim().toLowerCase();
  const filtered = q
    ? tools.filter(
        (t) =>
          t.name.includes(q) ||
          t.group.includes(q) ||
          (t.description ?? '').toLowerCase().includes(q),
      )
    : tools;
  const byGroup = new Map<string, ToolRecord[]>();
  for (const t of filtered) {
    const list = byGroup.get(t.group) ?? [];
    list.push(t);
    byGroup.set(t.group, list);
  }
  const presets = Object.entries(catalog.data?.presets ?? {});

  return (
    <div className="grid gap-6">
      <PageHeader title="Tools" subtitle="Every governed tool in the registry, grouped by capability." />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {presets.map(([name, p]) => (
          <div key={name} className="rounded-xl border border-border bg-[#0c1220] p-4">
            <div className="flex items-center justify-between gap-2">
              <Code>{name}</Code>
              <span className="font-mono text-lg font-bold">{p.toolCount}</span>
            </div>
            <div className="mt-1 text-xs text-muted">{p.groups.length} groups · preset</div>
          </div>
        ))}
      </div>

      <Card title="Catalog" hint={`${filtered.length} of ${tools.length} tools`}>
        <div className="mb-4 max-w-md">
          <SearchInput value={filter} onChange={setFilter} placeholder="Filter by name, group, or description" />
        </div>
        <ErrorNote message={catalog.error} />
        {catalog.loading ? (
          <SkeletonRows rows={6} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={<Wrench size={22} />} title="No tools match" hint="Try a different filter." />
        ) : (
          [...byGroup.entries()].map(([group, list]) => (
            <div key={group} className="mb-5 last:mb-0">
              <h3 className="m-0 mb-2 text-xs font-semibold">
                <Code>{group}</Code> <span className="text-muted font-normal">{list.length} tools</span>
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {list.map((t) => (
                  <span
                    key={t.name}
                    title={t.description ?? t.name}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-[#0c1220] px-2.5 py-1 font-mono text-[11px] text-fg hover:border-[#344360] transition-colors"
                  >
                    {t.name}
                    <RiskBadge risk={t.risk} />
                  </span>
                ))}
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
