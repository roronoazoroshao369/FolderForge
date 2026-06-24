import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

export interface ProjectInfo {
  projectRoot: string;
  name: string;
  languageHints: string[];
  packageManagers: string[];
  git: boolean;
}

export interface DetectedCommands {
  packageManager: string | null;
  scripts: Record<string, string>;
  testFramework?: string;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function detectProject(root: string): ProjectInfo {
  const languageHints = new Set<string>();
  const packageManagers = new Set<string>();

  const checks: Array<[string, () => void]> = [
    ['package.json', () => languageHints.add('typescript')],
    ['tsconfig.json', () => languageHints.add('typescript')],
    ['pyproject.toml', () => languageHints.add('python')],
    ['requirements.txt', () => languageHints.add('python')],
    ['go.mod', () => languageHints.add('go')],
    ['Cargo.toml', () => languageHints.add('rust')],
    ['composer.json', () => languageHints.add('php')],
    ['pom.xml', () => languageHints.add('java')],
    ['build.gradle', () => languageHints.add('java')],
  ];
  for (const [file, fn] of checks) {
    if (existsSync(join(root, file))) fn();
  }

  if (existsSync(join(root, 'pnpm-lock.yaml'))) packageManagers.add('pnpm');
  else if (existsSync(join(root, 'yarn.lock'))) packageManagers.add('yarn');
  else if (existsSync(join(root, 'package-lock.json'))) packageManagers.add('npm');
  else if (existsSync(join(root, 'package.json'))) packageManagers.add('npm');
  if (existsSync(join(root, 'pyproject.toml'))) packageManagers.add('pip');
  if (existsSync(join(root, 'go.mod'))) packageManagers.add('go');
  if (existsSync(join(root, 'Cargo.toml'))) packageManagers.add('cargo');

  return {
    projectRoot: root,
    name: basename(root),
    languageHints: [...languageHints],
    packageManagers: [...packageManagers],
    git: existsSync(join(root, '.git')),
  };
}

export function detectCommands(root: string): DetectedCommands {
  const pkg = readJson(join(root, 'package.json'));
  if (pkg && typeof pkg.scripts === 'object' && pkg.scripts) {
    const scripts = pkg.scripts as Record<string, string>;
    let pm = 'npm';
    if (existsSync(join(root, 'pnpm-lock.yaml'))) pm = 'pnpm';
    else if (existsSync(join(root, 'yarn.lock'))) pm = 'yarn';
    const norm: Record<string, string> = {};
    for (const key of ['dev', 'start', 'test', 'build', 'lint', 'typecheck']) {
      if (scripts[key]) norm[key] = `${pm} run ${key}`;
    }
    let testFramework: string | undefined;
    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };
    if (deps?.vitest) testFramework = 'vitest';
    else if (deps?.jest) testFramework = 'jest';
    else if (deps?.mocha) testFramework = 'mocha';
    return { packageManager: pm, scripts: norm, ...(testFramework ? { testFramework } : {}) };
  }

  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'requirements.txt'))) {
    return {
      packageManager: 'pip',
      scripts: { test: 'pytest', lint: 'ruff check .', typecheck: 'mypy .' },
      testFramework: 'pytest',
    };
  }
  if (existsSync(join(root, 'go.mod'))) {
    return { packageManager: 'go', scripts: { test: 'go test ./...', build: 'go build ./...' }, testFramework: 'go test' };
  }
  if (existsSync(join(root, 'Cargo.toml'))) {
    return { packageManager: 'cargo', scripts: { test: 'cargo test', build: 'cargo build' }, testFramework: 'cargo test' };
  }
  if (existsSync(join(root, 'Makefile'))) {
    return { packageManager: 'make', scripts: { test: 'make test', build: 'make build' } };
  }
  return { packageManager: null, scripts: {} };
}
