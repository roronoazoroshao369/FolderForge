import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const roots = [
  'README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'SUPPORT.md',
  'CHANGELOG.md', 'docs', '.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE',
];
const errors = [];

function walk(path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return extname(absolute) === '.md' ? [absolute] : [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    entry.name.startsWith('.') ? [] : walk(join(path, entry.name))
  );
}

function anchorFor(value) {
  return value.toLowerCase().trim()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

const files = [...new Set(roots.flatMap(walk))];
const headingsByFile = new Map();
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const display = relative(root, file);
  const fenceCount = (text.match(/^\s*```/gm) ?? []).length;
  if (fenceCount % 2 !== 0) errors.push(`${display}: unbalanced fenced code blocks`);

  const seen = new Map();
  const anchors = new Set();
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const heading = match[1].replace(/\s+#+\s*$/, '').trim();
    const key = heading.toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
    anchors.add(anchorFor(heading));
  }
  if (display !== 'CHANGELOG.md') {
    for (const [heading, count] of seen) {
      if (count > 1) errors.push(`${display}: duplicate heading "${heading}"`);
    }
  }
  headingsByFile.set(normalize(file), anchors);

  if (/X-API-Key:\s*\[REDACTED\](?!["`\s<])/i.test(text) || /\?token=\s*\[REDACTED\]/i.test(text)) {
    errors.push(`${display}: broken redaction fragment`);
  }

  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const href = match[1].trim().replace(/^<|>$/g, '');
    if (!href || /^(?:https?:|mailto:|#)/i.test(href)) continue;
    const [rawPath, rawAnchor] = href.split('#', 2);
    const decodedPath = decodeURIComponent(rawPath || '');
    const target = resolve(dirname(file), decodedPath || '.');
    if (!existsSync(target)) {
      errors.push(`${display}: broken relative link ${href}`);
      continue;
    }
    if (rawAnchor && statSync(target).isFile() && extname(target) === '.md') {
      let anchors = headingsByFile.get(normalize(target));
      if (!anchors) {
        anchors = new Set([...readFileSync(target, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => anchorFor(m[1])));
        headingsByFile.set(normalize(target), anchors);
      }
      if (!anchors.has(rawAnchor.toLowerCase())) errors.push(`${display}: missing anchor ${href}`);
    }
  }
}

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
if (!new RegExp(`^## \\[${packageJson.version.replaceAll('.', '\\.') }\\]`, 'm').test(changelog)) {
  errors.push(`CHANGELOG.md: missing heading for package version ${packageJson.version}`);
}
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
if (lock.version !== packageJson.version || lock.packages?.['']?.version !== packageJson.version) {
  errors.push('package-lock.json: root version does not match package.json');
}
const readme = readFileSync(join(root, 'README.md'), 'utf8');
if (/current(?: package)? version\D+\d+\.\d+\.\d+/i.test(readme)) {
  errors.push('README.md: avoid hard-coded current-version claims');
}

if (errors.length) {
  console.error(`Documentation checks failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Documentation checks passed for ${files.length} Markdown files; package version ${packageJson.version}.`);
