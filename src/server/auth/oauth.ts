import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { OAuthHttpAuthConfig, ToolPrincipal } from "../../core/types.js";

const MAX_DISCOVERY_BYTES = 1024 * 1024;

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri?: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean;
  token_endpoint_auth_methods_supported?: string[];
  [key: string]: unknown;
}

export interface VerifiedOAuthToken {
  subject: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  payload: JWTPayload;
}

export interface OAuthRuntime {
  config: OAuthHttpAuthConfig;
  authorizationServerMetadata: AuthorizationServerMetadata;
  protectedResourceMetadata: Record<string, unknown>;
  protectedResourceMetadataPaths: string[];
  resourceMetadataUrl: string;
  verifyAccessToken(token: string): Promise<VerifiedOAuthToken>;
  principalFor(token: VerifiedOAuthToken): ToolPrincipal;
}

function normalizeIssuer(raw: string): string {
  const url = new URL(raw);
  if (url.pathname === "/") url.pathname = "";
  return url.href.replace(/\/$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function validateRemoteUrl(
  label: string,
  raw: string,
  allowInsecure: boolean,
): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.hash) {
    throw new Error(`${label} contains forbidden userinfo or fragment`);
  }
  if (url.protocol !== "https:") {
    if (!(
      allowInsecure &&
      url.protocol === "http:" &&
      isLoopbackHostname(url.hostname)
    )) {
      throw new Error(`${label} must use HTTPS`);
    }
  }
  return url;
}

export function authorizationServerDiscoveryUrls(issuerRaw: string): URL[] {
  const issuer = new URL(issuerRaw);
  const path =
    issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  const urls: URL[] = [];
  if (path) {
    urls.push(
      new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin),
    );
    urls.push(
      new URL(`/.well-known/openid-configuration${path}`, issuer.origin),
    );
    urls.push(
      new URL(`${path}/.well-known/openid-configuration`, issuer.origin),
    );
  } else {
    urls.push(
      new URL("/.well-known/oauth-authorization-server", issuer.origin),
    );
    urls.push(new URL("/.well-known/openid-configuration", issuer.origin));
  }
  return urls;
}

async function fetchJson(
  url: URL,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_DISCOVERY_BYTES) {
    throw new Error("metadata response exceeded 1 MiB");
  }
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata response must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requireString(
  metadata: Record<string, unknown>,
  field: string,
): string {
  const value = metadata[field];
  if (typeof value !== "string" || !value)
    throw new Error(`authorization metadata missing ${field}`);
  return value;
}

function optionalStringArray(
  metadata: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = metadata[field];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(
      `authorization metadata field ${field} must be a string array`,
    );
  }
  return value as string[];
}

export async function discoverAuthorizationServer(
  config: OAuthHttpAuthConfig,
): Promise<AuthorizationServerMetadata> {
  const allowInsecure = Boolean(config.allowInsecureHttpForDevelopment);
  const configuredIssuer = normalizeIssuer(config.issuer);
  const timeoutMs = config.requestTimeoutMs ?? 5_000;
  const failures: string[] = [];

  for (const url of authorizationServerDiscoveryUrls(config.issuer)) {
    try {
      validateRemoteUrl("authorization metadata URL", url.href, allowInsecure);
      const raw = await fetchJson(url, timeoutMs);
      const issuer = normalizeIssuer(requireString(raw, "issuer"));
      if (issuer !== configuredIssuer) {
        throw new Error(
          `issuer mismatch: expected ${configuredIssuer}, got ${issuer}`,
        );
      }
      const authorizationEndpoint = requireString(
        raw,
        "authorization_endpoint",
      );
      const tokenEndpoint = requireString(raw, "token_endpoint");
      validateRemoteUrl(
        "authorization_endpoint",
        authorizationEndpoint,
        allowInsecure,
      );
      validateRemoteUrl("token_endpoint", tokenEndpoint, allowInsecure);

      const pkceMethods =
        optionalStringArray(raw, "code_challenge_methods_supported") ?? [];
      if (!pkceMethods.includes("S256")) {
        throw new Error(
          "authorization server metadata must advertise PKCE S256",
        );
      }

      if (
        config.clientRegistration === "cimd" &&
        raw.client_id_metadata_document_supported !== true
      ) {
        throw new Error(
          "clientRegistration=cimd requires client_id_metadata_document_supported=true",
        );
      }
      if (config.clientRegistration === "dcr") {
        const registrationEndpoint = requireString(
          raw,
          "registration_endpoint",
        );
        validateRemoteUrl(
          "registration_endpoint",
          registrationEndpoint,
          allowInsecure,
        );
      }

      const tokenAuthMethods = optionalStringArray(
        raw,
        "token_endpoint_auth_methods_supported",
      );
      if (
        tokenAuthMethods &&
        !tokenAuthMethods.some(
          (method) => method === "none" || method === "private_key_jwt",
        )
      ) {
        throw new Error(
          "token endpoint must support ChatGPT-compatible client authentication (none or private_key_jwt)",
        );
      }

      return {
        ...raw,
        issuer,
        authorization_endpoint: authorizationEndpoint,
        token_endpoint: tokenEndpoint,
        ...(typeof raw.jwks_uri === "string" ? { jwks_uri: raw.jwks_uri } : {}),
        ...(typeof raw.registration_endpoint === "string"
          ? { registration_endpoint: raw.registration_endpoint }
          : {}),
        code_challenge_methods_supported: pkceMethods,
        ...(typeof raw.client_id_metadata_document_supported === "boolean"
          ? {
              client_id_metadata_document_supported:
                raw.client_id_metadata_document_supported,
            }
          : {}),
        ...(tokenAuthMethods
          ? { token_endpoint_auth_methods_supported: tokenAuthMethods }
          : {}),
      };
    } catch (error) {
      failures.push(
        `${url.href}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    `OAuth authorization-server discovery failed:\n  - ${failures.join("\n  - ")}`,
  );
}

function resolveJwksUrl(
  config: OAuthHttpAuthConfig,
  metadata: AuthorizationServerMetadata,
): URL {
  const allowInsecure = Boolean(config.allowInsecureHttpForDevelopment);
  const raw = config.jwksUri ?? metadata.jwks_uri;
  if (!raw)
    throw new Error(
      "authorization metadata missing jwks_uri and no oauth.jwksUri override was configured",
    );
  const jwks = validateRemoteUrl("jwks_uri", raw, allowInsecure);
  if (!config.jwksUri) {
    const issuer = new URL(config.issuer);
    const trustedHosts = new Set([
      issuer.host.toLowerCase(),
      ...(config.trustedJwksHosts ?? []).map((host) => host.toLowerCase()),
    ]);
    if (!trustedHosts.has(jwks.host.toLowerCase())) {
      throw new Error(
        `Discovered JWKS host ${jwks.host} is not trusted; configure oauth.jwksUri or an exact trustedJwksHosts entry explicitly`,
      );
    }
  }
  return jwks;
}

function parseScopes(payload: JWTPayload): string[] {
  const scopes = new Set<string>();
  if (typeof payload.scope === "string") {
    for (const scope of payload.scope.split(/\s+/).filter(Boolean))
      scopes.add(scope);
  }
  const scp = payload.scp;
  if (typeof scp === "string") {
    for (const scope of scp.split(/\s+/).filter(Boolean)) scopes.add(scope);
  } else if (Array.isArray(scp)) {
    for (const scope of scp)
      if (typeof scope === "string" && scope) scopes.add(scope);
  }
  return [...scopes];
}

function oauthPrincipalId(
  issuer: string,
  subject: string,
  clientId: string,
): string {
  const digest = createHash("sha256")
    .update(`${issuer}\u0000${subject}\u0000${clientId}`)
    .digest("hex")
    .slice(0, 24);
  return `oauth:${digest}`;
}

export function protectedResourceMetadataPaths(resourceRaw: string): string[] {
  const resource = new URL(resourceRaw);
  const resourcePath =
    resource.pathname === "/" ? "" : resource.pathname.replace(/\/$/, "");
  const pathSpecific = `/.well-known/oauth-protected-resource${resourcePath}`;
  return pathSpecific === "/.well-known/oauth-protected-resource"
    ? [pathSpecific]
    : [pathSpecific, "/.well-known/oauth-protected-resource"];
}

export function resourceMetadataUrl(resourceRaw: string): string {
  const resource = new URL(resourceRaw);
  const [path] = protectedResourceMetadataPaths(resourceRaw);
  return new URL(path!, resource.origin).href;
}

export function buildProtectedResourceMetadata(
  config: OAuthHttpAuthConfig,
): Record<string, unknown> {
  return {
    resource: config.resource,
    authorization_servers: [normalizeIssuer(config.issuer)],
    scopes_supported: [...config.scopes],
    bearer_methods_supported: ["header"],
    resource_name: "FolderForge MCP",
    ...(config.resourceDocumentation
      ? { resource_documentation: config.resourceDocumentation }
      : {}),
  };
}

export function buildBearerChallenge(options: {
  resourceMetadataUrl: string;
  scopes: string[];
  error?: "invalid_token" | "insufficient_scope";
  errorDescription?: string;
}): string {
  const parts: string[] = [];
  if (options.error) parts.push(`error="${options.error}"`);
  if (options.errorDescription) {
    const safe = options.errorDescription.replace(/["\\\r\n]/g, " ");
    parts.push(`error_description="${safe}"`);
  }
  if (options.scopes.length) parts.push(`scope="${options.scopes.join(" ")}"`);
  parts.push(`resource_metadata="${options.resourceMetadataUrl}"`);
  return `Bearer ${parts.join(", ")}`;
}

export async function createOAuthRuntime(
  config: OAuthHttpAuthConfig,
): Promise<OAuthRuntime> {
  const metadata = await discoverAuthorizationServer(config);
  const jwksUrl = resolveJwksUrl(config, metadata);
  const remoteJwks = createRemoteJWKSet(jwksUrl, {
    timeoutDuration: config.requestTimeoutMs ?? 5_000,
    cacheMaxAge: config.jwksCacheTtlMs ?? 10 * 60_000,
    cooldownDuration: config.jwksCooldownMs ?? 30_000,
  });
  const issuer = normalizeIssuer(config.issuer);
  const algorithms = config.algorithms ?? ["RS256", "PS256", "ES256", "EdDSA"];
  const metadataUrl = resourceMetadataUrl(config.resource);

  return {
    config,
    authorizationServerMetadata: metadata,
    protectedResourceMetadata: buildProtectedResourceMetadata(config),
    protectedResourceMetadataPaths: protectedResourceMetadataPaths(
      config.resource,
    ),
    resourceMetadataUrl: metadataUrl,
    async verifyAccessToken(token: string): Promise<VerifiedOAuthToken> {
      if (token.split(".").length !== 3)
        throw new Error("access token is not a JWT");
      const { payload, protectedHeader } = await jwtVerify(token, remoteJwks, {
        issuer,
        audience: config.resource,
        algorithms,
        clockTolerance: config.clockToleranceSeconds ?? 5,
      });
      const tokenType = protectedHeader.typ?.toLowerCase();
      if (
        tokenType &&
        tokenType !== "at+jwt" &&
        tokenType !== "application/at+jwt"
      ) {
        throw new Error(`unexpected JWT type: ${protectedHeader.typ}`);
      }
      if (typeof payload.exp !== "number")
        throw new Error("access token is missing exp");
      const subject =
        typeof payload.sub === "string" && payload.sub
          ? payload.sub
          : "anonymous-subject";
      const clientId =
        typeof payload.client_id === "string" && payload.client_id
          ? payload.client_id
          : typeof payload.azp === "string" && payload.azp
            ? payload.azp
            : subject;
      return {
        subject,
        clientId,
        scopes: parseScopes(payload),
        expiresAt: payload.exp,
        payload,
      };
    },
    principalFor(token): ToolPrincipal {
      return {
        id: oauthPrincipalId(issuer, token.subject, token.clientId),
        role: "agent",
        authMode: "oauth",
        oauthClientId: token.clientId,
        scopes: [...token.scopes],
        resourceMetadataUrl: metadataUrl,
        readScope: config.readScope,
        writeScope: config.writeScope,
      };
    },
  };
}
