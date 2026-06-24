import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}
export function detectProject(root) {
    const languageHints = new Set();
    const packageManagers = new Set();
    const checks = [
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
        if (existsSync(join(root, file)))
            fn();
    }
    if (existsSync(join(root, 'pnpm-lock.yaml')))
        packageManagers.add('pnpm');
    else if (existsSync(join(root, 'yarn.lock')))
        packageManagers.add('yarn');
    else if (existsSync(join(root, 'package-lock.json')))
        packageManagers.add('npm');
    else if (existsSync(join(root, 'package.json')))
        packageManagers.add('npm');
    if (existsSync(join(root, 'pyproject.toml')))
        packageManagers.add('pip');
    if (existsSync(join(root, 'go.mod')))
        packageManagers.add('go');
    if (existsSync(join(root, 'Cargo.toml')))
        packageManagers.add('cargo');
    return {
        projectRoot: root,
        name: basename(root),
        languageHints: [...languageHints],
        packageManagers: [...packageManagers],
        git: existsSync(join(root, '.git')),
    };
}
export function detectCommands(root) {
    const pkg = readJson(join(root, 'package.json'));
    if (pkg && typeof pkg.scripts === 'object' && pkg.scripts) {
        const scripts = pkg.scripts;
        let pm = 'npm';
        if (existsSync(join(root, 'pnpm-lock.yaml')))
            pm = 'pnpm';
        else if (existsSync(join(root, 'yarn.lock')))
            pm = 'yarn';
        const norm = {};
        for (const key of ['dev', 'start', 'test', 'build', 'lint', 'typecheck']) {
            if (scripts[key])
                norm[key] = `${pm} run ${key}`;
        }
        let testFramework;
        const deps = {
            ...pkg.dependencies,
            ...pkg.devDependencies,
        };
        if (deps?.vitest)
            testFramework = 'vitest';
        else if (deps?.jest)
            testFramework = 'jest';
        else if (deps?.mocha)
            testFramework = 'mocha';
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
