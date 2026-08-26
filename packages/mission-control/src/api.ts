/**
 * API client for the governed dashboard endpoints. Mirrors the legacy UI's
 * convention: the bearer token comes from `?token=` or localStorage and is
 * appended as a query param (the dashboard also accepts the Authorization
 * header; the query param keeps static hosting simple).
 */

const TOKEN_KEY = 'folderforge.dashboard.token';

export function getToken(): string {
  return new URLSearchParams(location.search).get('token') || localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token: string): void {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export async function api<T = unknown>(
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<T> {
  const url = new URL(path, location.origin);
  const token = getToken();
  if (token) url.searchParams.set('token', token);
  const response = await fetch(url.toString(), {
    method: options?.method ?? 'GET',
    headers: options?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!response.ok) {
    const err = data as { message?: string; error?: string };
    throw new Error(err.message || err.error || `${path} → HTTP ${response.status}`);
  }
  return data as T;
}
