import { readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import fg from 'fast-glob';
import { bm25Rank, tokenize } from '../adapters/child-mcp/rank.js';

const DEFAULT_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,php,cs,c,cpp,h,hpp,md,json,yaml,yml,toml}';
const IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.venv/**',
  '**/vendor/**',
  '**/target/**',
];
const MAX_FILE_BYTES = 256_000;
const MAX_INDEX_BYTES = 4_000_000;
const INDEX_TEXT_BYTES = 48_000;

interface ContextOptions {
  query: string;
  glob?: string;
  maxResults?: number;
  maxFiles?: number;
  includeTests?: boolean;
  redact: (text: string) => string;
  isDenied: (absolutePath: string) => boolean;
}

interface IndexedFile {
  path: string;
  size: number;
  text: string;
}

function isLikelyTest(path: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec|e2e)(\/|$)|\.(test|spec)\.[^.]+$/i.test(path);
}

function fileKind(path: string): string {
  if (isLikelyTest(path)) return 'test';
  if (/readme|\.md$/i.test(path)) return 'documentation';
  if (/package\.json|tsconfig|pyproject|cargo\.toml|go\.mod|\.config\.|\.ya?ml$/i.test(path)) {
    return 'configuration';
  }
  return 'source';
}

function snippetsFor(text: string, query: string, redact: (value: string) => string): string[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const lines = text.split('\n');
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i]!.toLowerCase();
    if (terms.some((term) => lower.includes(term))) hits.push(i);
    if (hits.length >= 3) break;
  }
  return hits.map((line) => {
    const start = Math.max(0, line - 1);
    const end = Math.min(lines.length, line + 2);
    return redact(
      lines
        .slice(start, end)
        .map((value, index) => `${start + index + 1}: ${value.slice(0, 400)}`)
        .join('\n')
    );
  });
}

function relatedTests(path: string, allFiles: string[]): string[] {
  const stem = basename(path, extname(path)).replace(/\.(test|spec)$/i, '').toLowerCase();
  if (!stem || stem === 'index' || stem === 'main') return [];
  return allFiles
    .filter((candidate) => isLikelyTest(candidate) && basename(candidate).toLowerCase().includes(stem))
    .slice(0, 8);
}

export async function buildCodeContext(
  root: string,
  options: ContextOptions
): Promise<Record<string, unknown>> {
  const query = options.query.trim();
  if (!query) throw new Error('query is required.');
  const maxResults = Math.min(30, Math.max(1, Number(options.maxResults ?? 12)));
  const maxFiles = Math.min(2000, Math.max(1, Number(options.maxFiles ?? 500)));
  const files = await fg(options.glob ?? DEFAULT_GLOB, {
    cwd: root,
    onlyFiles: true,
    unique: true,
    ignore: IGNORE,
  });

  const indexed: IndexedFile[] = [];
  let indexedBytes = 0;
  let skippedLarge = 0;
  let skippedDenied = 0;
  for (const path of files.slice(0, maxFiles)) {
    const absolutePath = join(root, path);
    if (options.isDenied(absolutePath)) {
      skippedDenied++;
      continue;
    }
    try {
      const size = statSync(absolutePath).size;
      if (size > MAX_FILE_BYTES || indexedBytes + Math.min(size, INDEX_TEXT_BYTES) > MAX_INDEX_BYTES) {
        skippedLarge++;
        continue;
      }
      const text = readFileSync(absolutePath, 'utf8');
      if (text.includes('\0')) continue;
      const indexedText = text.slice(0, INDEX_TEXT_BYTES);
      indexed.push({ path, size, text });
      indexedBytes += Buffer.byteLength(indexedText);
    } catch {
      // Ignore files that disappear or become unreadable during the bounded scan.
    }
  }

  const ranked = bm25Rank(
    indexed.map((file) => ({ id: file.path, name: file.path, description: file.text.slice(0, INDEX_TEXT_BYTES) })),
    query
  ).slice(0, maxResults);
  const byPath = new Map(indexed.map((file) => [file.path, file]));

  const results = ranked.map(({ id, score }) => {
    const file = byPath.get(id)!;
    return {
      path: file.path,
      kind: fileKind(file.path),
      score: Number(score.toFixed(6)),
      size: file.size,
      snippets: snippetsFor(file.text, query, options.redact),
      relatedTests: options.includeTests === false ? [] : relatedTests(file.path, files),
    };
  });

  // Tests that match the query are valuable even when their corresponding source
  // file did not make the first BM25 page.
  const matchingTests = ranked
    .map((entry) => entry.id)
    .filter(isLikelyTest)
    .slice(0, 12);

  return {
    query,
    scannedFiles: Math.min(files.length, maxFiles),
    indexedFiles: indexed.length,
    indexedBytes,
    truncated: files.length > maxFiles || skippedLarge > 0,
    skippedLarge,
    skippedDenied,
    results,
    matchingTests,
    hints: {
      useSemanticTools: 'Use code_find_symbol/references/definition after selecting a concrete symbol.',
      contextIsBounded: true,
    },
  };
}
