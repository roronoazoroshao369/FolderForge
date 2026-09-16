import { useEffect, useState } from "react";
import { Cpu, Copy, RefreshCw, Share2 } from "lucide-react";
import { useAction, useApi } from "../hooks";
import type { TunnelRecord } from "../types";
import {
  Banner,
  Button,
  Card,
  Code,
  PageHeader,
  Select,
  SkeletonRows,
  StatePill,
  useToast,
} from "../ui";

type GatewayStatus = {
  gateway: {
    enabled: boolean;
    host: string;
    port: number;
    basePath: string;
    authMode: string;
    modelIds: string[];
    workflowId?: string;
  };
  implementationWorkflows: Array<{ id: string; name: string; state: string }>;
  compatibility: Record<string, string>;
};

export function ResponsesScreen() {
  const status = useApi<GatewayStatus>("/responses/status");
  const tunnels = useApi<{ tunnels: TunnelRecord[] }>("/tunnels");
  const tunnelAction = useAction();
  const workflowAction = useAction();
  const toast = useToast();
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const gateway = status.data?.gateway;
  const targetPort = gateway?.port;
  const gatewayTunnel = tunnels.data?.tunnels.find(
    (tunnel) =>
      tunnel.targetPort === targetPort &&
      (tunnel.state === "running" || tunnel.state === "starting"),
  );
  const baseUrl = gateway
    ? `${window.location.origin}${gateway.basePath}`
    : `${window.location.origin}/v1`;

  useEffect(() => {
    setSelectedWorkflowId(gateway?.workflowId ?? "");
  }, [gateway?.workflowId]);

  const saveWorkflow = async () => {
    const ok = await workflowAction.run("/responses/config", {
      workflowId: selectedWorkflowId || null,
    });
    if (ok) {
      status.reload();
      toast(
        "success",
        selectedWorkflowId
          ? "Default implementation workflow saved"
          : "Responses will pause safely without a default workflow",
      );
    }
  };

  const startGatewayTunnel = async () => {
    if (!targetPort) return;
    const ok = await tunnelAction.run("/tunnels", { targetPort });
    if (ok) {
      tunnels.reload();
      toast(
        "success",
        "HTTPS tunnel starting — public API URL will appear shortly",
      );
    }
  };

  const stopGatewayTunnel = async () => {
    if (!gatewayTunnel) return;
    const ok = await tunnelAction.run(
      `/tunnels/${encodeURIComponent(gatewayTunnel.id)}/stop`,
    );
    if (ok) {
      tunnels.reload();
      toast("success", "HTTPS API tunnel stopped");
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast("success", `${label} copied`);
    } catch {
      toast("error", "Clipboard access is unavailable");
    }
  };

  return (
    <div className="grid gap-6">
      <PageHeader
        title="OpenAI-compatible API"
        subtitle="Use this gateway from Codex or any OpenAI Responses client. MCP remains available separately at /mcp."
        actions={
          <Button size="sm" variant="ghost" onClick={() => status.reload()}>
            <RefreshCw size={13} aria-hidden /> Refresh
          </Button>
        }
      />

      <Banner tone="info">
        Configure Codex with the base URL below and model{" "}
        <Code>folderforge-agent</Code>. Requests enter the governed Agent Loop
        pipeline; do not point Codex at <Code>/mcp</Code> as a model endpoint.
      </Banner>

      {status.loading ? <SkeletonRows rows={3} /> : null}
      {status.error ? <Banner tone="warn">{status.error}</Banner> : null}

      {gateway ? (
        <Card title="Gateway status" hint="Mission Control managed">
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <StatePill value={gateway.enabled ? "enabled" : "disabled"} />
              <span className="text-sm text-muted">Auth</span>
              <Code>{gateway.authMode}</Code>
              <span className="text-sm text-muted">Bind</span>
              <Code>
                {gateway.host}:{gateway.port}
              </Code>
            </div>
            <div className="grid gap-1">
              <span className="text-xs text-muted">Base URL</span>
              <div className="flex flex-wrap items-center gap-2">
                <Code className="text-sm">{baseUrl}</Code>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void copy(baseUrl, "Base URL")}
                >
                  <Copy size={13} aria-hidden /> Copy
                </Button>
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <div className="rounded-lg border border-border-soft bg-[#0c1220] p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Cpu size={14} /> Models
                </div>
                <div className="mt-2 grid gap-1">
                  {gateway.modelIds.map((model) => (
                    <Code key={model}>{model}</Code>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-border-soft bg-[#0c1220] p-3">
                <div className="text-sm font-medium">Compatible routes</div>
                <div className="mt-2 grid gap-1 text-xs text-muted">
                  <span>
                    <Code>GET</Code> {status.data?.compatibility.models}
                  </span>
                  <span>
                    <Code>POST</Code> {status.data?.compatibility.responses}
                  </span>
                  <span>
                    <Code>GET</Code> {status.data?.compatibility.polling}
                  </span>
                  <span>
                    <Code>POST</Code> {status.data?.compatibility.cancellation}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      <Card
        title="Implementation workflow"
        hint="Governed default for /v1 requests"
      >
        <div className="grid gap-3">
          <p className="text-sm text-muted">
            Select a validated workflow for the implementation phase. Without a
            default, requests still run discovery and council but end as
            <Code>failed</Code> instead of mutating the repository implicitly.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid min-w-[18rem] flex-1 gap-1 text-xs text-muted">
              Default workflow
              <Select
                value={selectedWorkflowId}
                onChange={(event) => setSelectedWorkflowId(event.target.value)}
                disabled={workflowAction.busy}
              >
                <option value="">None — pause safely</option>
                {(status.data?.implementationWorkflows ?? []).map(
                  (workflow) => (
                    <option key={workflow.id} value={workflow.id}>
                      {workflow.name} · {workflow.state} · {workflow.id}
                    </option>
                  ),
                )}
              </Select>
            </label>
            <Button
              size="sm"
              onClick={() => void saveWorkflow()}
              disabled={workflowAction.busy || !gateway?.enabled}
            >
              Save workflow
            </Button>
          </div>
          {workflowAction.error ? (
            <Banner tone="warn">{workflowAction.error}</Banner>
          ) : null}
        </div>
      </Card>

      <Card
        title="Public HTTPS gateway"
        hint="Generic Cloudflare tunnel for /v1"
      >
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Share2 size={15} aria-hidden />
            <span className="text-sm text-muted">
              This uses the generic FolderForge tunnel manager, not the OpenAI
              Secure MCP Tunnel.
            </span>
          </div>
          {gatewayTunnel?.publicUrl ? (
            <div className="grid gap-1">
              <span className="text-xs text-muted">
                Public Responses base URL
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Code className="text-sm">{gatewayTunnel.publicUrl}/v1</Code>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void copy(`${gatewayTunnel.publicUrl}/v1`, "Public API URL")
                  }
                >
                  <Copy size={13} aria-hidden /> Copy
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">
              Start a public HTTPS tunnel to use Codex from another machine.
              Authentication on the HTTP transport remains required.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {gatewayTunnel ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void stopGatewayTunnel()}
                disabled={tunnelAction.busy}
              >
                Stop tunnel
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => void startGatewayTunnel()}
                disabled={!gateway?.enabled || !targetPort || tunnelAction.busy}
              >
                Start HTTPS tunnel
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => tunnels.reload()}
              disabled={tunnels.loading}
            >
              Refresh tunnel
            </Button>
          </div>
          {tunnelAction.error ? (
            <Banner tone="warn">{tunnelAction.error}</Banner>
          ) : null}
          {!gateway?.enabled ? (
            <Banner tone="warn">
              Enable the FolderForge HTTP transport first; MCP and /v1 share
              that authenticated port.
            </Banner>
          ) : null}
        </div>
      </Card>

      <Card title="Codex connection">
        <ol className="grid gap-2 text-sm text-muted list-decimal pl-5">
          <li>
            Set the Codex provider base URL to <Code>{baseUrl}</Code>.
          </li>
          <li>
            Choose <Code>folderforge-agent</Code> as the model.
          </li>
          <li>Use the configured FolderForge bearer/API key.</li>
          <li>
            Expose the HTTP port through a real HTTPS tunnel or reverse proxy;
            never expose an unauthenticated bind.
          </li>
        </ol>
      </Card>
    </div>
  );
}
