import { useEffect, useState } from 'react';
import { getToken, setToken } from '../api';
import { useAction, useApi } from '../hooks';
import { Button, Card, ErrorNote, Field, Input, PageHeader, Select, useToast } from '../ui';
import type { StatusSnapshot } from '../types';

const POLICY_MODES = ['readonly', 'safe', 'dev', 'danger'];

export function SettingsScreen() {
  const toast = useToast();
  const status = useApi<StatusSnapshot>('/status');
  const action = useAction();
  const [token, setTokenValue] = useState(getToken());
  const [mode, setMode] = useState('dev');

  useEffect(() => {
    const current = status.data?.policy?.mode;
    if (current) setMode(current);
  }, [status.data]);

  return (
    <div className="grid gap-6 max-w-3xl">
      <PageHeader title="Settings" subtitle="Local dashboard preferences and the runtime policy mode." />

      <Card title="Dashboard bearer token" hint="stored per browser (localStorage)">
        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-60">
            <Input
              type="password"
              value={token}
              onChange={(e) => setTokenValue(e.target.value)}
              placeholder="Bearer token"
              aria-label="Dashboard bearer token"
            />
          </div>
          <Button
            variant="primary"
            onClick={() => {
              setToken(token.trim());
              location.reload();
            }}
          >
            Save &amp; reload
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setToken('');
              location.reload();
            }}
          >
            Clear
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted">
          Loopback binds skip auth; the token is required when the dashboard is reached through a tunnel or a
          non-loopback bind.
        </p>
      </Card>

      <Card title="Policy mode" hint="admin only">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Runtime policy" className="w-56">
            <Select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Policy mode">
              {POLICY_MODES.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </Select>
          </Field>
          <Button
            variant="primary"
            disabled={action.busy}
            busy={action.busy}
            onClick={() =>
              void action.run('/policy/mode', { mode }).then((ok) => {
                if (ok) {
                  status.reload();
                  toast('success', `Policy mode → ${mode}`);
                }
              })
            }
          >
            Apply
          </Button>
        </div>
        <ErrorNote message={action.error} />
      </Card>
    </div>
  );
}
