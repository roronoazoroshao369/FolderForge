import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearResponsesGatewayConfig,
  loadResponsesGatewayConfig,
  responsesGatewayConfigPath,
  saveResponsesGatewayConfig,
} from "../../src/control/responses-gateway-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "folderforge-responses-gateway-"));
  roots.push(root);
  return root;
}

describe("Responses gateway config store", () => {
  it("round-trips the workflow selection with private permissions", () => {
    const root = makeRoot();
    const saved = saveResponsesGatewayConfig(root, "wf_abc123");

    expect(saved.workflowId).toBe("wf_abc123");
    expect(loadResponsesGatewayConfig(root)).toMatchObject({ workflowId: "wf_abc123" });
    expect(statSync(responsesGatewayConfigPath(root)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(responsesGatewayConfigPath(root), "utf8"))).toMatchObject({
      workflowId: "wf_abc123",
    });
  });

  it("ignores malformed or unsafe workflow ids", () => {
    const root = makeRoot();
    const file = responsesGatewayConfigPath(root);
    mkdirSync(join(root, ".folderforge"), { recursive: true });
    writeFileSync(file, JSON.stringify({ workflowId: "not-a-workflow" }), "utf8");

    expect(loadResponsesGatewayConfig(root)).toBeNull();
  });

  it("clears the persisted selection", () => {
    const root = makeRoot();
    saveResponsesGatewayConfig(root, "wf_abc123");

    clearResponsesGatewayConfig(root);

    expect(loadResponsesGatewayConfig(root)).toBeNull();
  });
});
