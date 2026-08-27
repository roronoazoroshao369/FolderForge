import { useMemo, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { useApi } from '../hooks';
import { Card, Code, DataTable, EmptyState, ErrorNote, PageHeader, RiskBadge, SearchInput, SkeletonRows } from '../ui';
import type { AuditRecord } from '../types';

export function AuditScreen() {
  const audit = useApi<unknown>('/audit?limit=50', 8000);
  const [filter, setFilter] = useState('');

  const events: AuditRecord[] = useMemo(() => {
    const d = audit.data;
    if (Array.isArray(d)) return d as AuditRecord[];
    if (d && typeof d === 'object') {
      const obj = d as { events?: AuditRecord[]; audit?: AuditRecord[] };
      return obj.events ?? obj.audit ?? [];
    }
    return [];
  }, [audit.data]);

  const q = filter.trim().toLowerCase();
  const filtered = q
    ? events.filter(
        (e) =>
          (e.type ?? '').toLowerCase().includes(q) ||
          (e.summary ?? '').toLowerCase().includes(q) ||
          (e.status ?? e.risk ?? '').toLowerCase().includes(q),
      )
    : events;

  return (
    <div className="grid gap-6">
      <PageHeader title="Audit" subtitle="Every governed action, recorded. Latest 50 events." />
      <Card
        title="Audit log"
        hint={q ? `${filtered.length} of ${events.length}` : `${events.length} events`}
      >
        <div className="mb-4 max-w-md">
          <SearchInput value={filter} onChange={setFilter} placeholder="Filter by type, summary, or status" />
        </div>
        {audit.loading ? (
          <SkeletonRows rows={5} />
        ) : (
          <DataTable
            head={['Time', 'Type', 'Summary', 'Risk']}
            rows={filtered.map((e, i) => [
              <Code key={`t${i}`} className="whitespace-nowrap">{e.timestamp ?? e.time ?? '—'}</Code>,
              <Code key={`y${i}`}>{e.type ?? '—'}</Code>,
              <span key={`s${i}`} className="inline-block max-w-[420px] truncate align-middle" title={e.summary}>
                {e.summary ?? '—'}
              </span>,
              e.risk ? <RiskBadge key={`x${i}`} risk={e.risk} /> : <span key={`x${i}`} className="text-muted">{e.status ?? '—'}</span>,
            ])}
            empty={
              <EmptyState
                icon={<ScrollText size={22} />}
                title={q ? 'No events match' : 'No audit events yet'}
                hint="Governed tool calls appear here as they happen."
              />
            }
          />
        )}
        <ErrorNote message={audit.error} />
      </Card>
    </div>
  );
}
