import { randomBytes } from 'node:crypto';

/** Generate the ephemeral API key used only by the authenticated HTTP smoke fixture. */
export function makeHttpSmokeApiKey(randomBytesFn = randomBytes) {
  return `smoke_${randomBytesFn(32).toString('base64url')}`;
}
