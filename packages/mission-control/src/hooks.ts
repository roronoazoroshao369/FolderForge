import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/** Poll a governed dashboard endpoint; tracks first-load for skeleton states. */
export function useApi<T>(path: string, refreshMs = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
          setLoading(false);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        });
    };
    load();
    const timer = setInterval(load, refreshMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path, tick, refreshMs]);
  return { data, error, loading, reload };
}

/** Run a POST action against the governed API with busy + error state. */
export function useAction() {
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
