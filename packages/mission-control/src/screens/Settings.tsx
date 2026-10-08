import { useEffect, useRef, useState } from 'react';
import { getToken, setToken } from '../api';
import { useAction, useApi } from '../hooks';
import { Button, Card, ErrorNote, Field, Input, PageHeader, Select, useToast } from '../ui';
import type { StatusSnapshot } from '../types';

const POLICY_MODES = ['readonly', 'safe', 'dev', 'danger'];

interface RuntimeSettingsView {
  terminal: {
    defaultTimeoutMs: number;
    maxOutputBytes: number;
    envPolicy: string;
    sandbox: { mode: string; requireInDanger: boolean };
  };
  updatedAt?: string;
}

export function SettingsScreen() {
  const toast = useToast();
  const status = useApi<StatusSnapshot>('/status');
  const runtime = useApi<RuntimeSettingsView>('/runtime/settings');
  const action = useAction();
  const [token, setTokenValue] = useState(getToken());
  const [mode, setMode] = useState('dev');
  const [timeout, setTimeout] = useState('120000');
  const [outputBytes, setOutputBytes] = useState('200000');
  const hydratedRuntimeKey = useRef<string | null>(null);

  useEffect(() => {
    const current = status.data?.policy?.mode;
    if (current) setMode(current);
  }, [status.data]);

  useEffect(() => {
    if (!runtime.data) return;
    const key = [
      runtime.data.terminal.defaultTimeoutMs,
      runtime.data.terminal.maxOutputBytes,
      runtime.data.updatedAt ?? '',
    ].join(':');
    // Background status polling must not overwrite a form being edited.
    if (hydratedRuntimeKey.current === key) return;
    hydratedRuntimeKey.current = key;
    setTimeout(String(runtime.data.terminal.defaultTimeoutMs));
    setOutputBytes(String(runtime.data.terminal.maxOutputBytes));
  }, [runtime.data]);

  return (
    <div className="grid gap-6 max-w-3xl">
      <PageHeader title="Settings" subtitle="Manage persistent policy and bounded terminal preferences from the running Control Panel." />

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

      <Card title="Policy mode" hint="admin only · saved across restart">
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

      <Card title="Terminal execution" hint="effective runtime configuration">
        {runtime.error ? <ErrorNote message={runtime.error} /> : null}
        {runtime.data ? (
          <div className="grid gap-4">
            <div className="rounded-lg border border-border bg-raised p-3 text-sm">
              <p>Sandbox engine: <strong>{runtime.data.terminal.sandbox.mode}</strong></p>
              <p>Required for danger mode: <strong>{runtime.data.terminal.sandbox.requireInDanger ? 'Yes' : 'No'}</strong></p>
              <p>Environment policy: <strong>{runtime.data.terminal.envPolicy}</strong></p>
              {mode === 'danger' && runtime.data.terminal.sandbox.mode === 'process' &&
                runtime.data.terminal.sandbox.requireInDanger ? (
                <p className="mt-2 text-danger">
                  Danger-mode shell commands are blocked until a Docker/Podman
                  sandbox is configured. Changing policy mode alone does not disable containment.
                </p>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Default command timeout (ms)">
                <Input type="number" min={1000} max={1800000} step={1000}
                  value={timeout} onChange={(event) => setTimeout(event.target.value)}
                  aria-label="Terminal timeout in milliseconds" />
              </Field>
              <Field label="Maximum captured output (bytes)">
                <Input type="number" min={1024} max={2000000} step={1024}
                  value={outputBytes} onChange={(event) => setOutputBytes(event.target.value)}
                  aria-label="Terminal output limit in bytes" />
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <Button variant="primary" busy={action.busy} disabled={action.busy}
                onClick={() => void action.run('/runtime/settings', {
                  defaultTimeoutMs: Number(timeout),
                  maxOutputBytes: Number(outputBytes),
                }).then((ok) => {
                  if (ok) {
                    runtime.reload();
                    toast('success', 'Terminal preferences saved');
                  }
                })}>
                Save terminal limits
              </Button>
              <p className="text-xs text-muted">Saved preferences survive process restarts.</p>
            </div>
            <p className="text-xs text-muted">
              The sandbox engine and its containment requirement are configured
              at server startup, not through this remote-accessible page. To
              change them, update the trusted host configuration and restart the service.
              Hard command denies, workspace authorization, audit and rate limits remain enforced.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted">Loading runtime configuration…</p>
        )}
        <ErrorNote message={action.error} />
      </Card>
    </div>
  );
}
