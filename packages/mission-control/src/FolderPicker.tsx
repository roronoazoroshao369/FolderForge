import { useCallback, useEffect, useState } from 'react';
import { ArrowUp, Check, FolderPlus, Home, Loader2, RotateCw } from 'lucide-react';
import { api } from './api';
import { Button, Input, Modal } from './ui';
import type { BrowseResult } from './types';

/**
 * Server-bounded directory picker. Browsing is restricted by the control
 * plane to the widest governable directory (status.workspace.browsePoint).
 */
export function FolderPicker(props: {
  open: boolean;
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const load = useCallback(async (path?: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<BrowseResult>('/fs/browse', {
        method: 'POST',
        body: path ? { path } : {},
      });
      setBrowse(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!props.open) return;
    void load(props.initialPath);
  }, [props.open, props.initialPath, load]);

  const createFolder = async () => {
    if (!browse || !newName.trim()) return;
    setError(null);
    try {
      const result = await api<{ ok: boolean; path: string }>('/fs/mkdir', {
        method: 'POST',
        body: { path: browse.path, name: newName.trim() },
      });
      setCreating(false);
      setNewName('');
      await load(result.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal open={props.open} title="Choose a folder" onClose={props.onClose}>
      <div className="grid gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <code className="flex-1 min-w-0 truncate font-mono text-xs text-blue" title={browse?.path}>
            {browse?.path ?? '…'}
          </code>
          <Button size="sm" variant="ghost" title="Home directory" onClick={() => void load(browse?.home)} disabled={busy || !browse}>
            <Home size={14} aria-hidden />
          </Button>
          <Button size="sm" variant="ghost" title="Up one level" onClick={() => void load(browse?.parent)} disabled={busy || !browse?.canGoUp}>
            <ArrowUp size={14} aria-hidden />
          </Button>
          <Button size="sm" variant="ghost" title="Reload" onClick={() => void load(browse?.path)} disabled={busy}>
            <RotateCw size={14} aria-hidden className={busy ? 'animate-spin' : ''} />
          </Button>
        </div>

        <div className="rounded-lg border border-border bg-[#0b1119] max-h-64 overflow-y-auto">
          {busy && !browse ? (
            <div className="p-4 grid place-items-center text-muted">
              <Loader2 size={18} className="animate-spin" aria-hidden />
            </div>
          ) : browse && browse.directories.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted">No subfolders here.</div>
          ) : (
            <ul className="m-0 p-1 list-none">
              {browse?.directories.map((d) => (
                <li key={d.path}>
                  <button
                    type="button"
                    onClick={() => void load(d.path)}
                    className="w-full text-left px-2.5 py-1.5 rounded-md text-[13px] font-mono text-fg hover:bg-raised transition-colors truncate"
                  >
                    {d.name}/
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {creating ? (
          <div className="flex gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="new-folder-name"
              aria-label="New folder name"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createFolder();
              }}
            />
            <Button size="sm" variant="primary" disabled={!newName.trim()} onClick={() => void createFolder()}>
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="subtle" className="w-fit" onClick={() => setCreating(true)}>
            <FolderPlus size={14} aria-hidden /> New folder here
          </Button>
        )}

        {error ? (
          <div className="rounded-lg border border-[#71302d] bg-[#2a1313] px-3 py-2 text-xs text-danger">
            {error}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2 pt-1 border-t border-border-soft">
          <span className="text-[11px] text-muted truncate">Browsing limited to {browse?.root ?? '…'}</span>
          <Button
            variant="primary"
            disabled={!browse || busy}
            onClick={() => {
              if (browse) props.onSelect(browse.path);
              props.onClose();
            }}
          >
            <Check size={14} aria-hidden /> Select this folder
          </Button>
        </div>
      </div>
    </Modal>
  );
}
