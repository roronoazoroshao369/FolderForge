import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const IMPORT_PATTERN = /\b(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g;

export function collectTypeScriptFiles(root) {
  const files = [];
  walk(root, files);
  return files.filter((path) => path.endsWith('.ts')).sort();
}

function walk(path, files) {
  for (const name of readdirSync(path)) {
    const child = resolve(path, name);
    const stat = statSync(child);
    if (stat.isDirectory()) walk(child, files);
    else files.push(child);
  }
}

export function parseStaticImports(source) {
  const imports = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    imports.push({
      kind: match[1],
      typeOnly: Boolean(match[2]),
      specifier: match[3],
    });
  }
  return imports;
}

export function resolveSourceImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const absolute = resolve(dirname(fromFile), specifier);
  const candidates = [];
  if (absolute.endsWith('.js')) candidates.push(`${absolute.slice(0, -3)}.ts`);
  else if (absolute.endsWith('.mjs')) candidates.push(`${absolute.slice(0, -4)}.mts`);
  else {
    candidates.push(absolute, `${absolute}.ts`, resolve(absolute, 'index.ts'));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function buildRuntimeGraph(sourceRoot) {
  const files = collectTypeScriptFiles(sourceRoot);
  const graph = new Map(files.map((file) => [file, new Set()]));
  const imports = new Map();
  for (const file of files) {
    const parsed = parseStaticImports(readFileSync(file, 'utf8'));
    imports.set(file, parsed);
    for (const item of parsed) {
      if (item.typeOnly) continue;
      const target = resolveSourceImport(file, item.specifier);
      if (target && graph.has(target)) graph.get(file).add(target);
    }
  }
  return { files, graph, imports };
}

export function findCycles(graph) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowLinks = new Map();
  const cycles = [];

  function strongConnect(node) {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of graph.get(node) ?? []) {
      if (!indices.has(target)) {
        strongConnect(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const item = stack.pop();
      onStack.delete(item);
      component.push(item);
      if (item === node) break;
    }
    const selfCycle = component.length === 1 && graph.get(component[0])?.has(component[0]);
    if (component.length > 1 || selfCycle) cycles.push(component.sort());
  }

  for (const node of graph.keys()) if (!indices.has(node)) strongConnect(node);
  return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}

export function checkArchitecture(projectRoot) {
  const sourceRoot = resolve(projectRoot, 'src');
  const { files, graph, imports } = buildRuntimeGraph(sourceRoot);
  const violations = [];
  const verticalRoots = new Set([
    'adapters',
    'artifacts',
    'browser',
    'chatgpt',
    'dashboard',
    'distributed',
    'managers',
    'marketplace',
    'plugins',
    'runtime',
    'server',
    'tools',
    'workflows',
  ]);

  for (const file of files) {
    const projectPath = slash(relative(projectRoot, file));
    const sourceParts = slash(relative(sourceRoot, file)).split('/');
    for (const item of imports.get(file) ?? []) {
      const target = resolveSourceImport(file, item.specifier);
      if (!target) continue;
      const targetParts = slash(relative(sourceRoot, target)).split('/');
      if (
        sourceParts[0] === 'core' &&
        verticalRoots.has(targetParts[0])
      ) {
        violations.push({
          code: 'core_imports_vertical',
          from: projectPath,
          to: slash(relative(projectRoot, target)),
          typeOnly: item.typeOnly,
        });
      }
      if (
        projectPath === 'src/server/mcp-task-manager.ts' &&
        slash(relative(projectRoot, target)) === 'src/tools/registry.ts'
      ) {
        violations.push({
          code: 'task_manager_imports_registry',
          from: projectPath,
          to: 'src/tools/registry.ts',
          typeOnly: item.typeOnly,
        });
      }
      if (
        projectPath === 'src/tools/registry.ts' &&
        slash(relative(projectRoot, target)) === 'src/runtime/container.ts'
      ) {
        violations.push({
          code: 'registry_imports_container',
          from: projectPath,
          to: 'src/runtime/container.ts',
          typeOnly: item.typeOnly,
        });
      }
    }
  }

  const packagesRoot = resolve(projectRoot, 'packages');
  if (existsSync(packagesRoot)) {
    for (const packageName of readdirSync(packagesRoot)) {
      const packageRoot = resolve(packagesRoot, packageName);
      const packageSource = resolve(packageRoot, 'src');
      if (!existsSync(packageSource) || !statSync(packageSource).isDirectory()) continue;
      for (const file of collectTypeScriptFiles(packageSource)) {
        for (const item of parseStaticImports(readFileSync(file, 'utf8'))) {
          if (!item.specifier.startsWith('.')) continue;
          const target = resolveSourceImport(file, item.specifier);
          if (target && !target.startsWith(`${packageSource}${sep}`)) {
            violations.push({
              code: 'package_imports_outside_source',
              from: slash(relative(projectRoot, file)),
              to: slash(relative(projectRoot, target)),
              typeOnly: item.typeOnly,
            });
          }
        }
      }
    }
  }

  const cycles = findCycles(graph).map((component) =>
    component.map((file) => slash(relative(projectRoot, file))),
  );
  return {
    ok: cycles.length === 0 && violations.length === 0,
    files: files.length,
    runtimeEdges: [...graph.values()].reduce((sum, targets) => sum + targets.size, 0),
    cycles,
    violations,
  };
}

function slash(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}
