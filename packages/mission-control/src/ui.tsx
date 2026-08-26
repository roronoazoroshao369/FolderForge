import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { CheckCircle2, Loader2, Search, X, XCircle } from 'lucide-react';

/* ---------- utilities ---------- */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function Code(props: { children: ReactNode; className?: string }) {
  return (
    <code className={cx('font-mono text-xs text-blue break-all', props.className)}>
      {props.children}
    </code>
  );
}

/* ---------- buttons & forms ---------- */

export function Button(props: {
  variant?: 'primary' | 'danger' | 'ghost' | 'subtle';
  size?: 'sm' | 'md';
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  title?: string;
  type?: 'button' | 'submit';
  className?: string;
}) {
  const variant = props.variant ?? 'subtle';
  const size = props.size ?? 'md';
  return (
    <button
      type={props.type ?? 'button'}
      title={props.title}
      disabled={props.disabled || props.busy}
      onClick={props.onClick}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors duration-150',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-[13px]',
        variant === 'primary' && 'border-[#297956] text-accent hover:bg-accent-deep/60',
        variant === 'danger' && 'border-[#71302d] text-danger hover:bg-[#2a1313]',
        variant === 'ghost' && 'border-transparent text-muted hover:text-fg hover:bg-raised',
        variant === 'subtle' && 'border-border bg-raised text-fg hover:border-[#344360]',
        props.className,
      )}
    >
      {props.busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
      {props.children}
    </button>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        'w-full rounded-lg border border-border bg-raised px-3 py-2 text-[13px] text-fg',
        'placeholder:text-muted/70 focus:border-accent/60 focus:outline-none transition-colors',
        props.className,
      )}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(
        'rounded-lg border border-border bg-raised px-2.5 py-2 text-[13px] text-fg',
        'focus:border-accent/60 focus:outline-none transition-colors',
        props.className,
      )}
    />
  );
}

export function Field(props: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('grid gap-1.5 min-w-0', props.className)}>
      <span className="text-xs text-muted">{props.label}</span>
      {props.children}
    </label>
  );
}

export function SearchInput(props: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="relative">
      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
      <Input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        aria-label={props.placeholder ?? 'Search'}
        className="pl-8"
      />
    </div>
  );
}

/* ---------- surfaces ---------- */

export function Card(props: {
  title?: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        'rounded-[14px] border border-border bg-gradient-to-b from-panel-2 to-panel overflow-hidden',
        props.className,
      )}
    >
      {props.title ? (
        <header className="flex items-center justify-between gap-4 px-4 py-3 border-b border-border">
          <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[1px] text-muted">
            {props.title}
          </h2>
          <div className="flex items-center gap-2">
            {props.hint ? <span className="text-xs text-muted">{props.hint}</span> : null}
            {props.actions}
          </div>
        </header>
      ) : null}
      <div className="p-4">{props.children}</div>
    </section>
  );
}

export function Stat(props: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const tone = props.tone ?? 'default';
  return (
    <div className="rounded-xl border border-border bg-[#0c1220] p-4 flex items-center gap-3 min-w-0">
      {props.icon ? (
        <div
          className={cx(
            'grid place-items-center w-9 h-9 rounded-lg shrink-0',
            tone === 'good' && 'bg-accent-deep text-accent',
            tone === 'warn' && 'bg-[#403410] text-warn',
            tone === 'bad' && 'bg-[#431918] text-danger',
            tone === 'default' && 'bg-raised text-blue',
          )}
        >
          {props.icon}
        </div>
      ) : null}
      <div className="min-w-0">
        <div className="font-mono text-xl font-bold leading-tight">{props.value}</div>
        <div className="text-xs text-muted truncate">{props.label}</div>
      </div>
    </div>
  );
}

const STATE_STYLES: Record<string, { dot: string; pill: string; pulse?: boolean }> = {
  running: { dot: 'bg-accent', pill: 'bg-accent-deep/60 text-accent', pulse: true },
  enabled: { dot: 'bg-accent', pill: 'bg-accent-deep/60 text-accent' },
  current: { dot: 'bg-accent', pill: 'bg-accent-deep/60 text-accent' },
  healthy: { dot: 'bg-accent', pill: 'bg-accent-deep/60 text-accent' },
  failed: { dot: 'bg-danger', pill: 'bg-[#431918]/70 text-danger' },
  starting: { dot: 'bg-warn', pill: 'bg-[#403410]/70 text-warn', pulse: true },
  stopping: { dot: 'bg-warn', pill: 'bg-[#403410]/70 text-warn', pulse: true },
  pending: { dot: 'bg-warn', pill: 'bg-[#403410]/70 text-warn', pulse: true },
  stopped: { dot: 'bg-muted', pill: 'bg-raised text-muted' },
  disabled: { dot: 'bg-muted', pill: 'bg-raised text-muted' },
  registered: { dot: 'bg-muted', pill: 'bg-raised text-muted' },
};

export function StatePill(props: { value: string }) {
  const v = props.value || 'unknown';
  const style = STATE_STYLES[v] ?? { dot: 'bg-blue', pill: 'bg-raised text-blue' };
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[11px]', style.pill)}>
      <span className={cx('w-1.5 h-1.5 rounded-full', style.dot, style.pulse && 'animate-pulse-dot')} aria-hidden />
      {v}
    </span>
  );
}

export function RiskBadge(props: { risk: string }) {
  const r = props.risk.toUpperCase();
  return (
    <span
      className={cx(
        'inline-flex rounded-md px-1.5 py-0.5 font-mono text-[10px] tracking-wide',
        r === 'LOW' && 'bg-raised text-muted',
        r === 'MEDIUM' && 'bg-[#403410]/70 text-warn',
        r === 'HIGH' && 'bg-[#431918]/70 text-danger',
        r === 'CRITICAL' && 'bg-[#431918] text-danger border border-danger/40',
      )}
    >
      {r}
    </span>
  );
}

/* ---------- data display ---------- */

export function DataTable(props: { head: string[]; rows: ReactNode[][]; empty: ReactNode }) {
  if (props.rows.length === 0) return <>{props.empty}</>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border-soft">
      <table className="w-full border-collapse text-[13px] [&>tbody>tr:last-child>td]:border-b-0">
        <thead>
          <tr>
            {props.head.map((h) => (
              <th
                key={h}
                className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.8px] text-muted font-semibold border-b border-border bg-panel-2"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((cells, i) => (
            <tr key={i} className="hover:bg-raised/50 transition-colors">
              {cells.map((cell, j) => (
                <td key={j} className="px-3 py-2 border-b border-border-soft align-middle">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyState(props: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      {props.icon ? <div className="text-muted mb-1">{props.icon}</div> : null}
      <div className="text-sm text-fg">{props.title}</div>
      {props.hint ? <div className="text-xs text-muted max-w-sm">{props.hint}</div> : null}
    </div>
  );
}

export function SkeletonRows(props: { rows?: number }) {
  return (
    <div className="grid gap-2" aria-hidden>
      {Array.from({ length: props.rows ?? 3 }).map((_, i) => (
        <div key={i} className="h-9 rounded-lg bg-raised/70 animate-pulse" />
      ))}
    </div>
  );
}

export function ErrorNote(props: { message: string | null }) {
  if (!props.message) return null;
  return (
    <div className="mt-3 rounded-lg border border-[#71302d] bg-[#2a1313] px-3 py-2.5 text-[13px] text-danger animate-fade-in">
      {props.message}
    </div>
  );
}

export function Banner(props: { tone: 'warn' | 'info'; children: ReactNode }) {
  return (
    <div
      className={cx(
        'rounded-lg border px-3 py-2.5 text-[13px]',
        props.tone === 'warn' && 'border-[#6b571d] text-warn bg-[#30270d]/60',
        props.tone === 'info' && 'border-[#26476b] text-blue bg-[#0d1b2c]/60',
      )}
    >
      {props.children}
    </div>
  );
}

/* ---------- modal ---------- */

export function Modal(props: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.open, props.onClose]);
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-40 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/60 animate-fade-in" onClick={props.onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        className="relative z-10 w-full max-w-md rounded-[14px] border border-border bg-panel p-4 shadow-pop animate-slide-up"
      >
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="m-0 text-sm font-semibold">{props.title}</h2>
          <button onClick={props.onClose} aria-label="Close dialog" className="text-muted hover:text-fg p-1 rounded-md transition-colors">
            <X size={15} />
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

/* ---------- toasts ---------- */

type ToastKind = 'success' | 'error';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

const ToastContext = createContext<(kind: ToastKind, message: string) => void>(() => undefined);

export function useToast(): (kind: ToastKind, message: string) => void {
  return useContext(ToastContext);
}

export function ToastProvider(props: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++;
    setItems((list) => [...list, { id, kind, message }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {props.children}
      <div className="fixed top-4 right-4 z-50 grid gap-2 w-80 max-w-[calc(100vw-2rem)]" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={cx(
              'flex items-start gap-2 rounded-xl border px-3.5 py-2.5 shadow-pop animate-slide-up text-[13px]',
              t.kind === 'success' ? 'border-[#297956] bg-[#0d1f17] text-accent' : 'border-[#71302d] bg-[#2a1313] text-danger',
            )}
          >
            {t.kind === 'success' ? (
              <CheckCircle2 size={15} className="mt-0.5 shrink-0" aria-hidden />
            ) : (
              <XCircle size={15} className="mt-0.5 shrink-0" aria-hidden />
            )}
            <span className="min-w-0 break-words">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------- page scaffolding ---------- */

export function PageHeader(props: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="m-0 text-xl font-semibold tracking-tight">{props.title}</h1>
        {props.subtitle ? <p className="m-0 mt-1 text-[13px] text-muted">{props.subtitle}</p> : null}
      </div>
      {props.actions ? <div className="flex items-center gap-2">{props.actions}</div> : null}
    </div>
  );
}
