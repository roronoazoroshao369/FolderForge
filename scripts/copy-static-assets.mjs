import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
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

// Mission Control SPA: shipped at dist/dashboard/app when the package has been
// built (npm run build:mission-control). Absent in minimal/dev builds — the
// dashboard then serves the vanilla UI only.
const spaSource = join(root, 'packages', 'mission-control', 'dist');
const spaTarget = join(root, 'dist', 'dashboard', 'app');
if (existsSync(join(spaSource, 'index.html'))) {
  mkdirSync(spaTarget, { recursive: true });
  cpSync(spaSource, spaTarget, { recursive: true });
}
