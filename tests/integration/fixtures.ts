import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the TypeScript fixture project. */
export const TS_FIXTURE = resolve(__dirname, '..', 'fixtures', 'sample-ts-project');

/** Absolute path to the Python fixture project. */
export const PY_FIXTURE = resolve(__dirname, '..', 'fixtures', 'sample-python-project');
