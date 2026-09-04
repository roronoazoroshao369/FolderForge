/**
 * Minimal OpenAI API probe behind Mission Control's "Verify key" action.
 *
 * One cheap authenticated GET answers the operator's question "is this key
 * actually valid?" before it is saved or used to boot the tunnel supervisor.
 * The base URL is env-overridable so tests can point at a local fake (mirrors
 * the Cloudflare client's FOLDERFORGE_CF_API_BASE_URL).
 */

export const OPENAI_API_BASE_URL_ENV = 'FOLDERFORGE_OPENAI_API_BASE_URL';
const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com';

export type OpenAiKeyVerdict =
  | { ok: true; scope: 'full' | 'restricted'; detail: string }
  | { ok: false; code: 'invalid_key' | 'unreachable'; detail: string };

export async function verifyOpenAiKey(
  apiKey: string,
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<OpenAiKeyVerdict> {
  const baseUrl = (
    options.baseUrl ??
    process.env[OPENAI_API_BASE_URL_ENV] ??
    DEFAULT_OPENAI_API_BASE_URL
  ).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return {
      ok: false,
      code: 'unreachable',
      detail: `Could not reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status === 200) {
    return { ok: true, scope: 'full', detail: 'Key authenticated against the OpenAI API.' };
  }
  if (response.status === 401) {
    return { ok: false, code: 'invalid_key', detail: 'OpenAI rejected this key (HTTP 401).' };
  }
  if (response.status === 403) {
    // Organization/tunnel-scoped keys can lack the models scope yet still be
    // valid for the tunnel control plane.
    return {
      ok: true,
      scope: 'restricted',
      detail: 'Key authenticated; models scope is restricted (normal for tunnel-only keys).',
    };
  }
  return {
    ok: false,
    code: 'unreachable',
    detail: `Unexpected OpenAI response: HTTP ${response.status}.`,
  };
}
