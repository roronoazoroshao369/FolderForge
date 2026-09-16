import { BrainCircuit, CheckCircle2, CirclePause, Play, Plus, Rocket, Scale, ShieldCheck, Square } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api';
import { useAction, useApi } from '../hooks';
import { Button, Card, Code, EmptyState, ErrorNote, Field, Input, PageHeader, StatePill, Textarea, useToast } from '../ui';

type Loop = {
  id: string;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  experts: Array<{ id: string; role: string; weight: number; model?: string }>;
  councilMinVotes: number;
  councilThreshold: number;
  maxIterations: number;
  iteration: number;
  phase: string;
  state: string;
  currentIterationProposals: Array<{ id: string; expertId: string; summary: string; plan: string[]; risks: string[] }>;
  currentIterationVotes: Array<{ expertId: string; proposalId: string; score: number; approve: boolean }>;
  goalGate: { satisfied: boolean; passedCriteria: number; totalCriteria: number };
  decision?: { proposalId: string; consensus: number; approvalRate: number };
  pauseReason?: string;
  failure?: string;
};

export function AgentLoopsScreen() {
  const loops = useApi<{ loops: Loop[] }>('/agent-loops', 3000);
  const action = useAction();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [criteria, setCriteria] = useState('');
  const [maxIterations, setMaxIterations] = useState('20');
  const [selected, setSelected] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const list = loops.data?.loops ?? [];
  const selectedLoop = useMemo(() => list.find((item) => item.id === selected) ?? list[0], [list, selected]);

  const create = async () => {
    setCreateError(null);
    try {
      const result = await api<{ loop: Loop }>('/agent-loops', {
        method: 'POST',
        body: {
          title,
          goal,
          acceptanceCriteria: criteria.split('\n').map((item) => item.trim()).filter(Boolean),
          maxIterations: Number(maxIterations),
        },
      });
      setTitle(''); setGoal(''); setCriteria('');
      setSelected(result.loop.id);
      loops.reload();
      toast('success', 'Agent loop created');
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  };

  const run = async (id: string, verb: string) => {
    if (await action.run(`/agent-loops/${encodeURIComponent(id)}/${verb}`, verb === 'pause' ? { reason: 'Paused from Mission Control.' } : undefined)) {
      loops.reload();
      toast('success', `Loop ${verb} accepted`);
    }
  };

  return (
    <div className="grid gap-6">
      <PageHeader title="Agent loops" subtitle="Discovery → expert council → implementation → verification. The loop only completes when the goal gate passes." />
      <Card title="Create a governed loop" hint="remote workers can submit proposals and evidence through the same API">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Title"><Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Ship the new feature" /></Field>
          <Field label="Maximum iterations"><Input type="number" min="1" max="100" value={maxIterations} onChange={(event) => setMaxIterations(event.target.value)} /></Field>
          <Field label="Goal" className="md:col-span-2"><Textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={3} placeholder="What must be true when the loop stops?" /></Field>
          <Field label="Acceptance criteria (one per line)" className="md:col-span-2"><Textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} rows={4} placeholder={'npm test passes\nAPI contract is backward compatible\nNo critical security findings'} /></Field>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <ErrorNote message={createError} />
          <Button variant="primary" disabled={!title.trim() || !goal.trim() || !criteria.trim()} onClick={() => void create()}><Plus size={14} aria-hidden /> Create loop</Button>
        </div>
      </Card>

      {loops.error ? <ErrorNote message={loops.error} /> : null}
      {list.length === 0 ? <EmptyState icon={<BrainCircuit size={24} />} title="No agent loops" hint="Create a loop to coordinate discovery, council votes, implementation and verification." /> : (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
          <div className="grid content-start gap-2">
            {list.map((loop) => (
              <button key={loop.id} type="button" onClick={() => setSelected(loop.id)} className={`rounded-xl border p-3 text-left transition-colors ${selectedLoop?.id === loop.id ? 'border-[#297956] bg-[#10261d]' : 'border-border bg-card hover:border-[#344360]'}`}>
                <div className="flex items-start justify-between gap-3"><strong className="text-sm">{loop.title}</strong><StatePill value={loop.state} /></div>
                <div className="mt-1 text-xs text-muted">iteration {loop.iteration}/{loop.maxIterations} · {loop.phase}</div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#202936]"><div className="h-full rounded-full bg-accent" style={{ width: `${loop.goalGate.totalCriteria ? Math.round(loop.goalGate.passedCriteria / loop.goalGate.totalCriteria * 100) : 0}%` }} /></div>
              </button>
            ))}
          </div>
          {selectedLoop ? <LoopDetail loop={selectedLoop} busy={action.busy} error={action.error} onRun={run} /> : null}
        </div>
      )}
    </div>
  );
}

function LoopDetail(props: { loop: Loop; busy: boolean; error: string | null; onRun: (id: string, verb: string) => Promise<void> }) {
  const { loop } = props;
  return (
    <Card title={loop.title} hint={<Code>{loop.id}</Code>}>
      <div className="grid gap-4">
        <p className="m-0 text-sm leading-relaxed">{loop.goal}</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <Metric label="Phase" value={loop.phase} />
          <Metric label="Council" value={`${loop.currentIterationVotes.length}/${loop.councilMinVotes} votes`} />
          <Metric label="Goal gate" value={`${loop.goalGate.passedCriteria}/${loop.goalGate.totalCriteria} criteria`} good={loop.goalGate.satisfied} />
        </div>
        <div className="flex flex-wrap gap-2">
          {loop.state === 'created' || loop.state === 'paused' ? <Button size="sm" variant="primary" disabled={props.busy} onClick={() => void props.onRun(loop.id, 'run')}><Rocket size={13} aria-hidden /> Run autonomous loop</Button> : null}
          {loop.state === 'created' || loop.state === 'paused' ? <Button size="sm" variant="ghost" disabled={props.busy} onClick={() => void props.onRun(loop.id, 'start')}><Play size={13} aria-hidden /> Start / resume</Button> : null}
          {loop.state === 'running' ? <Button size="sm" variant="ghost" disabled={props.busy} onClick={() => void props.onRun(loop.id, 'pause')}><CirclePause size={13} aria-hidden /> Pause</Button> : null}
          {!['completed', 'failed', 'cancelled'].includes(loop.state) ? <Button size="sm" variant="danger" disabled={props.busy} onClick={() => void props.onRun(loop.id, 'cancel')}><Square size={13} aria-hidden /> Cancel</Button> : null}
          {loop.phase === 'council' && loop.state === 'running' ? <Button size="sm" variant="ghost" disabled={props.busy} onClick={() => void props.onRun(loop.id, 'decide')}><Scale size={13} aria-hidden /> Decide council</Button> : null}
        </div>
        <ErrorNote message={props.error} />
        <div className="grid gap-3 md:grid-cols-2">
          <section><h3 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Acceptance criteria</h3><ul className="m-0 grid gap-1 pl-5 text-xs">{loop.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ul></section>
          <section><h3 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Experts</h3><ul className="m-0 grid gap-1 pl-5 text-xs">{loop.experts.map((expert) => <li key={expert.id}><Code>{expert.id}</Code> — {expert.role}</li>)}</ul></section>
        </div>
        <section><h3 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Current proposals</h3>{loop.currentIterationProposals.length === 0 ? <p className="m-0 text-xs text-muted">Waiting for discovery agents to submit proposals through the API.</p> : <div className="grid gap-2">{loop.currentIterationProposals.map((proposal) => <div key={proposal.id} className="rounded-lg border border-border-soft p-2.5 text-xs"><div className="flex items-center gap-2"><BrainCircuit size={13} className="text-accent" aria-hidden /><Code>{proposal.expertId}</Code><span className="text-muted">{proposal.id}</span></div><p className="mt-1 mb-0">{proposal.summary}</p></div>)}</div>}</section>
        {loop.decision ? <div className="flex items-center gap-2 rounded-lg border border-[#297956] bg-[#10261d] px-3 py-2 text-xs"><CheckCircle2 size={14} className="text-accent" aria-hidden /> Council selected <Code>{loop.decision.proposalId}</Code> with {Math.round(loop.decision.consensus * 100)}% consensus.</div> : null}
        {loop.pauseReason ? <div className="rounded-lg border border-[#6b571d] bg-[#30270d]/40 px-3 py-2 text-xs text-warn">{loop.pauseReason}</div> : null}
        {loop.failure ? <div className="rounded-lg border border-[#6b3535] bg-[#2b1414]/60 px-3 py-2 text-xs text-danger">{loop.failure}</div> : null}
        <div className="flex items-center gap-2 text-[11px] text-muted"><ShieldCheck size={13} aria-hidden /> Remote API: <Code>/agent-loops/{loop.id}</Code></div>
      </div>
    </Card>
  );
}

function Metric(props: { label: string; value: string; good?: boolean }) {
  return <div className="rounded-lg border border-border-soft px-3 py-2"><div className="text-[11px] text-muted">{props.label}</div><div className={props.good ? 'mt-1 text-sm text-accent' : 'mt-1 text-sm'}>{props.value}</div></div>;
}
