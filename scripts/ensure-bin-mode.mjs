import { chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(root, 'dist', 'main.js');

if (!existsSync(bin)) {
  throw new Error(`Build output is missing: ${bin}`);
}

// Windows does not use POSIX executable mode bits. npm creates a .cmd shim for
// the package bin, so chmod would only make the build fail there.
if (process.platform !== 'win32') chmodSync(bin, 0o755);
