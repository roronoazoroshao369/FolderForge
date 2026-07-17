import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'src', 'dashboard', 'static', 'index.html');
const target = join(root, 'dist', 'dashboard', 'static', 'index.html');

if (!existsSync(source)) {
  throw new Error(`Dashboard source asset is missing: ${source}`);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
