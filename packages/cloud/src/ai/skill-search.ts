import { sql } from "bun";
import { toPgTextArray } from "../services/postgres";

const BM25_INDEX = "ai.skills_search_bm25_idx";
let bm25Available: Promise<boolean> | undefined;

/** BM25 only ranks candidates; native matching and access checks always apply. */
export async function withAiSkillSearch<T>(query: string, run: (bm25: boolean) => Promise<T>): Promise<T> {
  if (!query) return run(false);
  bm25Available ??= sql<{ available: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch')
      AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_am am ON am.oid = c.relam
        WHERE c.oid = to_regclass(${BM25_INDEX}) AND am.amname = 'bm25') AS available
  `.then((rows) => rows[0]?.available ?? false);
  const bm25 = await bm25Available;
  try {
    return await run(bm25);
  } catch (error) {
    const capabilityLost =
      typeof error === "object" &&
      error !== null &&
      ["code", "errno"].some((key) => key in error && ["0A000", "42704", "42883", "55000"].includes(String(Reflect.get(error, key))));
    if (!bm25 || !capabilityLost) throw error;
    bm25Available = Promise.resolve(false);
    return run(false);
  }
}

export function aiSkillSearchSql(query: string, bm25: boolean) {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  // Match every term in either field. Short prefixes stay exact; longer terms
  // tolerate typos without matching unrelated short words throughout the catalog.
  const matches = !query
    ? sql`TRUE`
    : !terms.length
      ? sql`FALSE`
      : sql`
    NOT EXISTS (SELECT 1 FROM unnest(${toPgTextArray(terms)}::text[]) AS term
      WHERE strpos(lower(skill.name), term) = 0 AND strpos(lower(skill.description), term) = 0
        AND (length(term) < 4 OR greatest(word_similarity(term, skill.name),
          word_similarity(term, skill.description)) < 0.35))
  `;
  const rank = !query
    ? sql`0::real`
    : sql`
    CASE WHEN lower(skill.name) = ${query.toLowerCase()} THEN 100 ELSE 0 END
    + CASE WHEN strpos(lower(skill.name), ${query.toLowerCase()}) > 0 THEN 10 ELSE 0 END
    + 2 * word_similarity(${query}, skill.name) + word_similarity(${query}, skill.description)
  `;
  const textRank = !query
    ? sql`0::real`
    : bm25
      ? sql`-(skill.search_text <@> to_bm25query(${query}, ${BM25_INDEX}))`
      : sql`ts_rank_cd(to_tsvector('simple', skill.search_text), plainto_tsquery('simple', ${query}))`;
  return { matches, rank, textRank };
}
