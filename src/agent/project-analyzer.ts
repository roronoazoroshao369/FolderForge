import { readFileSync, lstatSync } from 'node:fs';
import { basename, join } from 'node:path';
import fg from 'fast-glob';
import { simpleGit } from 'simple-git';
import { detectCommands, detectProject } from '../workspace/project-detector.js';

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  workspaces?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface AnalyzeOptions {
  resolveSafe?: (path: string) => string;
  isDenied?: (absolutePath: string) => boolean;
}

const FRAMEWORK_PACKAGES: Array<[string, string]> = [
  ['next', 'Next.js'],
  ['react', 'React'],
  ['vite', 'Vite'],
  ['vue', 'Vue'],
  ['nuxt', 'Nuxt'],
  ['svelte', 'Svelte'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['@angular/core', 'Angular'],
  ['astro', 'Astro'],
  ['express', 'Express'],
  ['@nestjs/core', 'NestJS'],
  ['fastify', 'Fastify'],
  ['electron', 'Electron'],
  ['vitest', 'Vitest'],
  ['jest', 'Jest'],
  ['playwright', 'Playwright'],
  ['@playwright/test', 'Playwright Test'],
];

const MANIFESTS = [
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'Makefile',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
];

const ENTRYPOINT_GLOBS = [
  'src/{main,index,app,server}.{ts,tsx,js,jsx,mjs,cjs,py}',
  'app/{page,layout}.{ts,tsx,js,jsx}',
  'pages/index.{ts,tsx,js,jsx}',
  '{main,app,server,index}.{ts,tsx,js,jsx,mjs,cjs,py,go,rs}',
  'cmd/**/main.go',
];

function safeFile(root: string, path: string, options: AnalyzeOptions): string | null {
  const candidate = join(root, path);
  if (options.isDenied?.(candidate)) return null;
  try {
    const resolved = options.resolveSafe?.(path) ?? candidate;
    const stat = lstatSync(resolved);
    return stat.isFile() && !stat.isSymbolicLink() ? resolved : null;
  } catch {
    return null;
  }
}

function safeDirectory(root: string, path: string, options: AnalyzeOptions): string | null {
  const candidate = join(root, path);
  if (options.isDenied?.(candidate)) return null;
  try {
    const resolved = options.resolveSafe?.(path) ?? candidate;
    const stat = lstatSync(resolved);
    return stat.isDirectory() && !stat.isSymbolicLink() ? resolved : null;
  } catch {
    return null;
  }
}

function safeFiles(root: string, paths: string[], options: AnalyzeOptions): string[] {
  return paths.filter((path) => safeFile(root, path, options) !== null);
}

function readPackage(root: string, options: AnalyzeOptions): PackageJson | null {
  try {
    const path = safeFile(root, 'package.json', options);
    if (!path) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

function readPythonFrameworks(root: string, options: AnalyzeOptions): string[] {
  const text = ['pyproject.toml', 'requirements.txt']
    .map((file) => safeFile(root, file, options))
    .filter((path): path is string => Boolean(path))
    .map((path) => readFileSync(path, 'utf8').toLowerCase())
    .join('\n');
  const found: string[] = [];
  if (/\bdjango\b/.test(text)) found.push('Django');
  if (/\bfastapi\b/.test(text)) found.push('FastAPI');
  if (/\bflask\b/.test(text)) found.push('Flask');
  if (/\bpytest\b/.test(text)) found.push('pytest');
  return found;
}

function existingDirectories(root: string, candidates: string[], options: AnalyzeOptions): string[] {
  return candidates.filter((dir) => safeDirectory(root, dir, options) !== null);
}

export async function analyzeProject(
  root: string,
  options: AnalyzeOptions = {}
): Promise<Record<string, unknown>> {
  const info = detectProject(root);
  const commands = detectCommands(root);
  const pkg = readPackage(root, options);
  const dependencies = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };
  const frameworks = FRAMEWORK_PACKAGES.filter(([name]) => dependencies[name] !== undefined).map(
    ([, label]) => label
  );
  frameworks.push(...readPythonFrameworks(root, options));

  const manifests = MANIFESTS.filter((file) => safeFile(root, file, options) !== null);
  const rawConfigFiles = await fg(
    [
      '*.{config,conf}.{js,cjs,mjs,ts,json,yaml,yml}',
      '.*rc',
      '.*rc.{js,cjs,mjs,json,yaml,yml}',
      '.github/workflows/*.{yaml,yml}',
    ],
    {
      cwd: root,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
    }
  );
  const configFiles = safeFiles(root, rawConfigFiles, options);
  const rawEntrypoints = await fg(ENTRYPOINT_GLOBS, {
    cwd: root,
    onlyFiles: true,
    unique: true,
    followSymbolicLinks: false,
    ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
  });
  const entrypoints = safeFiles(root, rawEntrypoints, options);
  const sourceRoots = existingDirectories(
    root,
    ['src', 'app', 'pages', 'lib', 'packages', 'apps', 'cmd'],
    options
  );
  const testRoots = existingDirectories(root, ['test', 'tests', '__tests__', 'spec', 'e2e'], options);
  const rawSourceFiles = await fg(
    ['**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,php,cs,c,cpp,h,hpp}'],
    {
      cwd: root,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        '**/.venv/**',
        '**/vendor/**',
      ],
    }
  );
  const sourceFiles = safeFiles(root, rawSourceFiles, options);

  let git: Record<string, unknown> = { repository: info.git };
  if (info.git) {
    try {
      const status = await simpleGit({ baseDir: root }).status();
      git = {
        repository: true,
        branch: status.current,
        clean: status.isClean(),
        ahead: status.ahead,
        behind: status.behind,
        changedFiles: [
          ...new Set([
            ...status.staged,
            ...status.modified,
            ...status.not_added,
            ...status.deleted,
            ...status.conflicted,
          ]),
        ].length,
      };
    } catch (error) {
      git = { repository: true, error: String(error) };
    }
  }

  const monorepoSignals = [
    pkg?.workspaces ? 'package.json#workspaces' : null,
    safeFile(root, 'pnpm-workspace.yaml', options) ? 'pnpm-workspace.yaml' : null,
    safeFile(root, 'turbo.json', options) ? 'turbo.json' : null,
    safeFile(root, 'nx.json', options) ? 'nx.json' : null,
  ].filter((value): value is string => Boolean(value));

  return {
    name: pkg?.name ?? basename(root),
    version: pkg?.version ?? null,
    private: pkg?.private ?? null,
    projectRoot: root,
    languages: info.languageHints,
    packageManagers: info.packageManagers,
    frameworks: [...new Set(frameworks)],
    commands,
    architecture: {
      monorepo: monorepoSignals.length > 0,
      monorepoSignals,
      sourceRoots,
      testRoots,
      entrypoints: entrypoints.slice(0, 30),
      sourceFileCount: sourceFiles.length,
    },
    manifests,
    configFiles: configFiles.slice(0, 50),
    git,
  };
}
