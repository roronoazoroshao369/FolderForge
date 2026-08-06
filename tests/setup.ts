import { afterAll } from 'vitest';
import { cleanupIsolatedFixtures } from './integration/fixtures.js';
import { installTestRuntimeIsolation } from './runtime-isolation.js';

// A developer or CI host may run an unrelated tunnel client (cloudflared,
// ngrok, ...). The HTTP transport refuses to start unauthenticated in that
// situation, which is correct in production but would make these tests depend
// on host state. The guard itself is covered with an injected probe in
// tests/unit/tunnel-and-async-run.test.ts.
const runtime = installTestRuntimeIsolation({ cleanupFixtures: cleanupIsolatedFixtures });

afterAll(() => runtime.cleanup());
