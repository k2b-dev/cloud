// ==========================
// Fuzzy Match & Levenshtein
// ==========================
//
// Two complementary string-matching tools:
//
// 1. Subsequence fuzzy match (`match`, `filter`, `segments`) for UI-style
//    search where the user types abbreviations like "udh" and expects
//    "userDashboard" to rank highly. Uses 2D DP with a fzf-inspired scoring
//    heuristic that rewards prefix matches, word boundaries, contiguous
//    runs, and case agreement.
//
// 2. Levenshtein edit distance (`distance`, `closest`) for typo-tolerant
//    "did you mean?" lookups against a known list of canonical strings.
//
// All functions are case-insensitive by default; pass `caseSensitive: true`
// to opt into strict matching. Levenshtein takes the fold into account so
// `closest("Hellp", ["Hello"])` returns distance 1 in either mode.

// ==========================
// TYPES
// ==========================

/** Result of a single fuzzy match. */
export type FuzzyMatch = {
  /** Higher = better. Raw score, only comparable within the same query. */
  score: number;
  /**
   * Matched character ranges in the target as `[start, endExclusive]` pairs,
   * sorted ascending and non-overlapping. Adjacent matched indices are
   * collapsed into a single range.
   */
  ranges: ReadonlyArray<readonly [number, number]>;
};

/** Hit produced by {@link filter}: match metadata plus the source item. */
export type FuzzyHit<T> = FuzzyMatch & {
  /** The original item from the input array. */
  item: T;
  /** The string used for matching (`key(item)` or the item itself). */
  target: string;
};

/** Result of {@link closest}: the chosen string with edit-distance metadata. */
export type ClosestMatch = {
  /** Chosen string from the input list (original casing preserved). */
  value: string;
  /** Levenshtein edit distance from the query. */
  distance: number;
  /** `1 - distance / max(query.length, value.length)`. Range: `[0, 1]`. */
  similarity: number;
};

/** A run of text from {@link segments}: one slice marked match or no-match. */
export type FuzzySegment = { text: string; match: boolean };

// ==========================
// SCORING CONSTANTS (internal)
// ==========================

const MATCH = 16;
const GAP_START = -3;
const GAP_EXTEND = -1;
const BONUS_CONTIG = 4; // applied per consecutive matched position
const BONUS_BOUNDARY = 8; // match starts at a word boundary
const BONUS_FIRST_CHAR = 12; // match at index 0 of the target (stronger than a generic boundary)
const BONUS_CASE_MATCH = 2; // query char and target char share casing

const NEG_INF = Number.NEGATIVE_INFINITY;

// ==========================
// CHAR-CODE HELPERS (perf)
// ==========================

const isUpper = (code: number): boolean => code >= 65 && code <= 90;
const isLower = (code: number): boolean => code >= 97 && code <= 122;
const isDigit = (code: number): boolean => code >= 48 && code <= 57;
const isWordChar = (code: number): boolean =>
  isLower(code) || isUpper(code) || isDigit(code) || code === 95; // _

/**
 * Boundary detection. Returns true at:
 *  - index 0 (handled by callers via `prevCode === -1`)
 *  - char following a non-word character (space, hyphen, dot, ...)
 *  - camelCase: lower/digit followed by uppercase
 *
 * ASCII-focused. Non-ASCII characters are treated as word chars (no boundary
 * unless preceded by a non-word ASCII separator). Sufficient for UI search.
 */
const isBoundary = (prevCode: number, currCode: number): boolean => {
  if (prevCode === -1) return true;
  if (!isWordChar(prevCode)) return true;
  if (isUpper(currCode) && (isLower(prevCode) || isDigit(prevCode))) return true;
  return false;
};

const collapseRanges = (positions: readonly number[]): Array<[number, number]> => {
  if (positions.length === 0) return [];
  const out: Array<[number, number]> = [];
  let start = positions[0]!;
  let end = start + 1;
  for (let i = 1; i < positions.length; i++) {
    const p = positions[i]!;
    if (p === end) {
      end = p + 1;
    } else {
      out.push([start, end]);
      start = p;
      end = p + 1;
    }
  }
  out.push([start, end]);
  return out;
};

// ==========================
// CORE: SUBSEQUENCE FUZZY DP
// ==========================
//
// Recurrence: `M[i][j]` is the best score for matching `query[0..=i]` with the
// last query char placed at `target[j]`. Transitions:
//
//   M[i][j] = baseScore(j) + max(
//     M[i-1][j-1] + BONUS_CONTIG,                           // contiguous
//     max over k in [i-1, j-2] of M[i-1][k] + GAP_START
//                                + (j-k-2) * GAP_EXTEND     // with gap
//   )
//
// Naively the inner max over k is O(T) → total O(Q·T²). We linearize it via a
// running prefix maximum of `E[k] = M[i-1][k] - k·GAP_EXTEND`, giving O(Q·T).
// Backtracking pointers (`back[i][j]`) reconstruct the matched positions.

const computeMatch = (
  query: string,
  target: string,
  caseSensitive: boolean,
): FuzzyMatch | null => {
  const qLen = query.length;
  const tLen = target.length;

  if (qLen === 0) return { score: 0, ranges: [] };
  if (tLen < qLen) return null;

  // Use `toLowerCase()` for case-insensitive matching so non-ASCII letters
  // fold correctly (`É` → `é`, etc.) — the previous `c + 32` trick only
  // worked for A-Z. We then fall back to charCodeAt on the folded strings.
  // Note: a few locale-specific lowercases change string length (rare); if
  // they do we keep the original char-codes for matching, which is still
  // correct for ASCII and most BMP scripts.
  const qFoldStr = caseSensitive ? query : query.toLowerCase();
  const tFoldStr = caseSensitive ? target : target.toLowerCase();
  const qFoldUsable = qFoldStr.length === qLen;
  const tFoldUsable = tFoldStr.length === tLen;

  // Pre-compute char codes (folded for matching, original for case bonus).
  const qOrig = new Uint16Array(qLen);
  const qFold = new Uint16Array(qLen);
  for (let i = 0; i < qLen; i++) {
    const c = query.charCodeAt(i);
    qOrig[i] = c;
    qFold[i] = caseSensitive
      ? c
      : qFoldUsable
        ? qFoldStr.charCodeAt(i)
        : isUpper(c)
          ? c + 32
          : c;
  }
  const tOrig = new Uint16Array(tLen);
  const tFold = new Uint16Array(tLen);
  for (let j = 0; j < tLen; j++) {
    const c = target.charCodeAt(j);
    tOrig[j] = c;
    tFold[j] = caseSensitive
      ? c
      : tFoldUsable
        ? tFoldStr.charCodeAt(j)
        : isUpper(c)
          ? c + 32
          : c;
  }

  // Subsequence pre-check: if q is not even a subsequence of t, bail out fast.
  let scanQ = 0;
  for (let scanT = 0; scanT < tLen && scanQ < qLen; scanT++) {
    if (qFold[scanQ] === tFold[scanT]) scanQ++;
  }
  if (scanQ < qLen) return null;

  // baseScore for landing the i-th query char at target index j.
  const baseScore = (i: number, j: number): number => {
    let s = MATCH;
    const prevCode = j === 0 ? -1 : tOrig[j - 1]!;
    if (j === 0) s += BONUS_FIRST_CHAR;
    else if (isBoundary(prevCode, tOrig[j]!)) s += BONUS_BOUNDARY;
    if (qOrig[i] === tOrig[j]) s += BONUS_CASE_MATCH;
    return s;
  };

  // Row 0 (first query char). prevScore[j] = best score for query[0..=0] ending at j.
  let prevScore = new Float64Array(tLen);
  for (let j = 0; j < tLen; j++) prevScore[j] = NEG_INF;
  for (let j = 0; j < tLen; j++) {
    if (qFold[0] === tFold[j]) prevScore[j] = baseScore(0, j);
  }

  // back[i][j] = previous target position (k) used at row i. Row 0 has no
  // predecessor, so we only allocate rows 1..qLen-1. To keep indexing clean
  // we use a sparse `Map`-free design: index `back[i-1]` for query char i.
  const back: Int32Array[] = [];

  for (let i = 1; i < qLen; i++) {
    const currScore = new Float64Array(tLen);
    for (let j = 0; j < tLen; j++) currScore[j] = NEG_INF;
    const currBack = new Int32Array(tLen).fill(-1);

    // Running prefix max over E[k] = prevScore[k] - k*GAP_EXTEND, k ∈ [i-1, j-2].
    let prefixMaxE = NEG_INF;
    let prefixMaxArgK = -1;

    for (let j = i; j < tLen; j++) {
      if (qFold[i] === tFold[j]) {
        const base = baseScore(i, j);
        let best = NEG_INF;
        let bestK = -1;

        // Contiguous (k = j - 1).
        if (j > 0 && prevScore[j - 1]! > NEG_INF) {
          const cand = prevScore[j - 1]! + base + BONUS_CONTIG;
          if (cand > best) {
            best = cand;
            bestK = j - 1;
          }
        }

        // With gap (k ∈ [i-1, j-2]) via running prefix max.
        if (prefixMaxE > NEG_INF) {
          const cand = prefixMaxE + j * GAP_EXTEND - 2 * GAP_EXTEND + GAP_START + base;
          if (cand > best) {
            best = cand;
            bestK = prefixMaxArgK;
          }
        }

        if (best > NEG_INF) {
          currScore[j] = best;
          currBack[j] = bestK;
        }
      }

      // After processing j, fold k = j-1 into the prefix-max pool for the
      // next iteration (where it becomes a valid "gap" predecessor).
      const kFold = j - 1;
      if (kFold >= i - 1 && prevScore[kFold]! > NEG_INF) {
        const e = prevScore[kFold]! - kFold * GAP_EXTEND;
        if (e > prefixMaxE) {
          prefixMaxE = e;
          prefixMaxArgK = kFold;
        }
      }
    }

    prevScore = currScore;
    back.push(currBack);
  }

  // Find best end column.
  let bestJ = -1;
  let bestScore = NEG_INF;
  for (let j = qLen - 1; j < tLen; j++) {
    if (prevScore[j]! > bestScore) {
      bestScore = prevScore[j]!;
      bestJ = j;
    }
  }
  if (bestJ === -1) return null;

  // Backtrack.
  const positions = new Array<number>(qLen);
  positions[qLen - 1] = bestJ;
  for (let i = qLen - 1; i >= 1; i--) {
    positions[i - 1] = back[i - 1]![positions[i]!]!;
  }

  return { score: bestScore, ranges: collapseRanges(positions) };
};

// ==========================
// LEVENSHTEIN
// ==========================
//
// Classic two-row DP. We always use the shorter string as columns to bound
// memory at O(min(a, b)).

const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  if (a.length > b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  const aLen = a.length;
  const bLen = b.length;
  let prev = new Uint32Array(aLen + 1);
  let curr = new Uint32Array(aLen + 1);
  for (let i = 0; i <= aLen; i++) prev[i] = i;

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j;
    const bCode = b.charCodeAt(j - 1);
    for (let i = 1; i <= aLen; i++) {
      const cost = a.charCodeAt(i - 1) === bCode ? 0 : 1;
      const ins = curr[i - 1]! + 1;
      const del = prev[i]! + 1;
      const sub = prev[i - 1]! + cost;
      curr[i] = ins < del ? (ins < sub ? ins : sub) : del < sub ? del : sub;
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[aLen]!;
};

// ==========================
// PUBLIC API
// ==========================

/**
 * Score a fuzzy subsequence match of `query` against `target`.
 *
 * Case-insensitive by default. Returns `null` if `query` is not a subsequence
 * of `target`. The returned `score` is raw and only meaningful when comparing
 * matches against the same query (e.g. for sorting). The returned `ranges`
 * are sorted, non-overlapping, and use `[start, endExclusive]` half-open
 * intervals -- ready to slice or render.
 *
 * @example
 * fuzzy.match("udh", "userDashboard")
 * //  { score: 78, ranges: [[0,1], [4,5], [7,8]] }
 *
 * @example
 * fuzzy.match("xyz", "userDashboard")     // null
 * fuzzy.match("UDH", "userDashboard")     // matches (case-insensitive default)
 * fuzzy.match("UDH", "userDashboard", { caseSensitive: true })  // null
 */
export const match = (
  query: string,
  target: string,
  opts: { caseSensitive?: boolean } = {},
): FuzzyMatch | null => computeMatch(query, target, opts.caseSensitive ?? false);

/**
 * Filter and rank a list of items by fuzzy-match score against `query`.
 *
 * Items without a match are dropped; remaining items are sorted by score
 * descending (stable for ties). Pass `key` to fuzzy-match against a derived
 * string when items aren't strings themselves. `limit` caps the returned
 * array (after sorting).
 *
 * Empty queries return all items with `score: 0` and empty `ranges`,
 * preserving original order -- useful for unfiltered fallback rendering.
 *
 * @example
 * fuzzy.filter("udh", ["userDashboard", "logout", "userHome"])
 * // [
 * //   { item: "userDashboard", target: "userDashboard", score: 78, ranges: [...] },
 * //   { item: "userHome",      target: "userHome",      score: 41, ranges: [...] },
 * // ]
 *
 * @example
 * fuzzy.filter("ab", users, { key: u => u.name, limit: 10 });
 */
export const filter = <T>(
  query: string,
  items: readonly T[],
  opts: {
    key?: (item: T) => string;
    limit?: number;
    caseSensitive?: boolean;
  } = {},
): Array<FuzzyHit<T>> => {
  const { key, limit, caseSensitive = false } = opts;
  const getTarget = key ?? ((x: T) => x as unknown as string);

  const hits: Array<FuzzyHit<T>> = [];
  for (const item of items) {
    const target = getTarget(item);
    // Defensive: without a `key` accessor, callers passing non-string items
    // would silently crash inside computeMatch. Throw a clear error early.
    if (typeof target !== "string") {
      throw new TypeError(
        `fuzzy.filter: target is not a string (got ${typeof target}). ` +
          "Pass a `key` accessor to extract a string from each item.",
      );
    }
    const m = computeMatch(query, target, caseSensitive);
    if (m !== null) {
      hits.push({ item, target, score: m.score, ranges: m.ranges });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return limit !== undefined ? hits.slice(0, limit) : hits;
};

/**
 * Split `target` into matched/non-matched runs based on `ranges`. Useful
 * for rendering highlighted hits in JSX:
 *
 * ```tsx
 * <For each={fuzzy.segments(hit.target, hit.ranges)}>
 *   {(seg) => seg.match ? <mark>{seg.text}</mark> : <>{seg.text}</>}
 * </For>
 * ```
 *
 * Ranges are expected to be the canonical sorted, non-overlapping shape
 * produced by {@link match} / {@link filter}.
 */
export const segments = (
  target: string,
  ranges: ReadonlyArray<readonly [number, number]>,
): FuzzySegment[] => {
  if (ranges.length === 0) {
    return target.length === 0 ? [] : [{ text: target, match: false }];
  }

  const out: FuzzySegment[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) {
      out.push({ text: target.slice(cursor, start), match: false });
    }
    if (end > start) {
      out.push({ text: target.slice(start, end), match: true });
    }
    cursor = end;
  }
  if (cursor < target.length) {
    out.push({ text: target.slice(cursor), match: false });
  }
  return out;
};

/**
 * Levenshtein edit distance between `a` and `b`. Case-sensitive (lowercase
 * the inputs yourself if you need a case-insensitive distance). Returns the
 * minimum number of single-char insertions, deletions, or substitutions
 * needed to transform one string into the other.
 *
 * @example
 * fuzzy.distance("color", "colour")   // 1
 * fuzzy.distance("kitten", "sitting") // 3
 * fuzzy.distance("", "abc")           // 3
 */
export const distance = (a: string, b: string): number => levenshtein(a, b);

/**
 * Find the entry in `choices` with the smallest Levenshtein distance to
 * `query`. Case-insensitive by default; use `caseSensitive: true` for strict
 * matching. Returns `null` if no choice falls within `maxDistance` (default
 * `Infinity`) or if `choices` is empty.
 *
 * @example
 * fuzzy.closest("hellp", ["hello", "help", "world"])
 * // { value: "hello", distance: 1, similarity: 0.8 }
 *
 * @example
 * fuzzy.closest("zzz", ["hello", "help"], { maxDistance: 2 })  // null
 */
export const closest = (
  query: string,
  choices: readonly string[],
  opts: { maxDistance?: number; caseSensitive?: boolean } = {},
): ClosestMatch | null => {
  if (choices.length === 0) return null;
  const { maxDistance = Infinity, caseSensitive = false } = opts;

  const q = caseSensitive ? query : query.toLowerCase();
  let bestValue = "";
  let bestDistance = Infinity;
  let found = false;

  for (const choice of choices) {
    const c = caseSensitive ? choice : choice.toLowerCase();
    const d = levenshtein(q, c);
    if (d < bestDistance) {
      bestDistance = d;
      bestValue = choice; // preserve original casing
      found = true;
      if (d === 0) break; // can't beat zero
    }
  }

  if (!found || bestDistance > maxDistance) return null;

  const maxLen = Math.max(query.length, bestValue.length);
  const similarity = maxLen === 0 ? 1 : 1 - bestDistance / maxLen;
  return { value: bestValue, distance: bestDistance, similarity };
};

// ==========================
// NAMESPACE
// ==========================

export const fuzzy = {
  match,
  filter,
  segments,
  distance,
  closest,
} as const;
