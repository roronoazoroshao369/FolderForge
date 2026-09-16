/**
 * Persisted Mission Control settings for the OpenAI-compatible Responses gateway.
 *
 * The gateway credential is configured by the HTTP transport and is never
 * stored here. This file only remembers the selected implementation workflow so
 * a dashboard restart does not silently fall back to an unrelated workflow.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ResponsesGatewayConfig {
  workflowId: string;
  linkedAt: string;
}

export function responsesGatewayConfigPath(projectRoot: string): string {
  return join(projectRoot, ".folderforge", "responses-gateway.json");
}

export function loadResponsesGatewayConfig(
  projectRoot: string,
): ResponsesGatewayConfig | null {
  const file = responsesGatewayConfigPath(projectRoot);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ResponsesGatewayConfig>;
    if (
      typeof raw.workflowId !== "string" ||
      !/^wf_[A-Za-z0-9]+$/.test(raw.workflowId)
    ) {
      return null;
    }
    return {
      workflowId: raw.workflowId,
      linkedAt: typeof raw.linkedAt === "string" ? raw.linkedAt : "",
    };
  } catch {
    return null;
  }
}

export function saveResponsesGatewayConfig(
  projectRoot: string,
  workflowId: string,
): ResponsesGatewayConfig {
  const dir = join(projectRoot, ".folderforge");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config: ResponsesGatewayConfig = {
    workflowId,
    linkedAt: new Date().toISOString(),
  };
  const file = responsesGatewayConfigPath(projectRoot);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  chmodSync(file, 0o600);
  return config;
}

export function clearResponsesGatewayConfig(projectRoot: string): void {
  rmSync(responsesGatewayConfigPath(projectRoot), { force: true });
}
