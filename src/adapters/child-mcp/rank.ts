/**
 * Lightweight BM25 ranking for the facade `list_tools` catalog (see
 * docs/mcp-facade.md, "Semantic/RAG tool search"). When the agent passes a
 * free-text `query`, the two-tool facade ranks a large child's sub-tools by
 * relevance instead of returning them in discovery order, so the most likely
 * sub-op surfaces on the first page within the token budget.
 *
 * This is a self-contained, dependency-free BM25 over each sub-tool's
 * `name` + `description`. It is deliberately tiny (no index persistence, no
 * stemming): a catalog is at most a few hundred short documents and is ranked
 * on demand. The `name_contains` substring filter remains available and is
 * applied *before* ranking, so the two can be combined.
 */

/** BM25 term-frequency saturation. Standard default. */
const K1 = 1.5;
/** BM25 length-normalisation strength. Standard default. */
const B = 0.75;

/**
 * Split an identifier or sentence into lowercase alphanumeric terms. Handles the
 * vocabularies facade sub-tools actually use: `snake_case`, `camelCase`,
 * `kebab-case`, dotted names, and plain prose. Single-character tokens are kept
 * (they are rare and can be meaningful, e.g. a tool literally named `x`).
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return (
    text
      // split camelCase / PascalCase boundaries into separate words
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      // any run of non-alphanumerics is a separator
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

/** A document to rank: an opaque id plus the text fields to index. */
export interface RankDoc {
  id: string;
  /** Weighted higher than description because a tool name is the strongest signal. */
  name: string;
  description?: string;
}

/** A ranked result: the doc id and its BM25 score (higher = more relevant). */
export interface RankResult {
  id: string;
  score: number;
}

/**
 * The name field is repeated this many times when building a document's term
 * bag, so a query hit on the tool name outweighs the same hit in the (usually
 * longer) description. Cheap, effective field boosting without a full fielded
 * index.
 */
const NAME_BOOST = 3;

/**
 * Rank `docs` against `query` using BM25 and return every doc with a score > 0,
 * highest first. Docs that match no query term are dropped (so a `query` also
 * acts as a relevance filter). Ties are broken by original order for stability.
 */
export function bm25Rank(docs: RankDoc[], query: string): RankResult[] {
  const qTerms = tokenize(query);
  if (qTerms.length === 0 || docs.length === 0) return [];

  // Build per-doc term frequencies (with name field boosted) and doc lengths.
  const docTerms: Array<Map<string, number>> = [];
  const docLen: number[] = [];
  const df = new Map<string, number>();

  for (const doc of docs) {
    const terms = [
      ...Array<string[]>(NAME_BOOST).fill(tokenize(doc.name)).flat(),
      ...tokenize(doc.description ?? ''),
    ];
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    docTerms.push(tf);
    docLen.push(terms.length);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const N = docs.length;
  const avgdl = docLen.reduce((a, b) => a + b, 0) / N || 1;

  const results: Array<RankResult & { order: number }> = [];
  for (let i = 0; i < N; i++) {
    const tf = docTerms[i]!;
    const len = docLen[i]!;
    let score = 0;
    for (const term of qTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      // BM25 IDF with the standard +0.5 smoothing; clamped at 0 so a term
      // present in every doc never subtracts from the score.
      const idf = Math.max(0, Math.log((N - n + 0.5) / (n + 0.5) + 1));
      const denom = f + K1 * (1 - B + (B * len) / avgdl);
      score += idf * ((f * (K1 + 1)) / denom);
    }
    if (score > 0) results.push({ id: docs[i]!.id, score, order: i });
  }

  results.sort((a, b) => (b.score - a.score) || (a.order - b.order));
  return results.map(({ id, score }) => ({ id, score }));
}
