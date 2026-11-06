/**
 * Display ligatures: typed character sequences that Notebooks shows as one
 * typographic symbol. Display only; the stored Markdown keeps the typed
 * characters, so search, export, the Assistant and collaboration never see a
 * substitution. Both the rich editor and the Book renderer use this table.
 */

/** How a sequence must sit in its surroundings before it becomes a symbol. */
type Guard =
  /** Not part of a longer operator run such as `-->`, `<==` or `!==`. */
  | "operator"
  /** Not glued to a word, so `f(c)` stays a call and `(c)2` stays literal. */
  | "word"
  /** Not followed by a word; a trademark sign usually follows its name, as in `Notebooks(tm)`. */
  | "suffix"
  /** Not part of a longer run of dots. */
  | "dots"
  /** Only between spaces, so `---`, `--flag` and table rules never match. */
  | "spaced";

type Ligature = { source: string; symbol: string; guard: Guard };

/** Longest sources first, so `<->` and `<=>` win over `<-`, `->`, `<=` and `=>`. */
export const LIGATURES: readonly Ligature[] = [
  { source: "(tm)", symbol: "™", guard: "suffix" },
  { source: "(TM)", symbol: "™", guard: "suffix" },
  { source: "<=>", symbol: "⇔", guard: "operator" },
  { source: "<->", symbol: "↔", guard: "operator" },
  { source: "...", symbol: "…", guard: "dots" },
  { source: "(c)", symbol: "©", guard: "word" },
  { source: "(C)", symbol: "©", guard: "word" },
  { source: "(r)", symbol: "®", guard: "word" },
  { source: "(R)", symbol: "®", guard: "word" },
  { source: "->", symbol: "→", guard: "operator" },
  { source: "<-", symbol: "←", guard: "operator" },
  { source: "=>", symbol: "⇒", guard: "operator" },
  { source: "<=", symbol: "≤", guard: "operator" },
  { source: ">=", symbol: "≥", guard: "operator" },
  { source: "!=", symbol: "≠", guard: "operator" },
  { source: "+-", symbol: "±", guard: "operator" },
  { source: "--", symbol: "–", guard: "spaced" },
];

export type LigatureMatch = { from: number; to: number; source: string; symbol: string };

const OPERATOR_CHARS = new Set(["<", ">", "=", "!", "+", "-", "~"]);
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const FIRST_CHARS = new Set(LIGATURES.map((ligature) => ligature.source[0]));

const accepts = (guard: Guard, before: string | undefined, after: string | undefined): boolean => {
  if (guard === "operator") return !(before && OPERATOR_CHARS.has(before)) && !(after && OPERATOR_CHARS.has(after));
  if (guard === "word") return !(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after));
  if (guard === "suffix") return !(after && WORD_CHAR.test(after));
  if (guard === "dots") return before !== "." && after !== ".";
  return (before === " " || before === "\t") && (after === " " || after === "\t");
};

/**
 * Finds display ligatures that start and end inside `[from, to)` of `text`.
 * Characters outside that window still count as neighbours; the ends of
 * `text` count as a boundary. Matches never overlap.
 */
export const findLigatures = (text: string, from = 0, to = text.length): LigatureMatch[] => {
  const matches: LigatureMatch[] = [];
  let index = from;
  while (index < to) {
    if (!FIRST_CHARS.has(text[index])) {
      index++;
      continue;
    }
    const ligature = LIGATURES.find(
      ({ source, guard }) =>
        index + source.length <= to && text.startsWith(source, index) && accepts(guard, text[index - 1], text[index + source.length]),
    );
    if (!ligature) {
      index++;
      continue;
    }
    matches.push({ from: index, to: index + ligature.source.length, source: ligature.source, symbol: ligature.symbol });
    index += ligature.source.length;
  }
  return matches;
};

/** Same escaping as Marked's text renderer: an entity the author typed (`&amp;`) stays an entity. */
const escapeHtml = (value: string): string =>
  value.replace(
    /[<>"']|&(?!#\d{1,7};|#[Xx][a-fA-F0-9]{1,6};|\w+;)/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

export const LIGATURE_CLASS = "notebook-ligature";

/** Marked-escaped HTML for inline text with each ligature as a span whose title keeps the typed characters. */
export const ligatureHtml = (text: string): string => {
  let html = "";
  let last = 0;
  for (const match of findLigatures(text)) {
    html += `${escapeHtml(text.slice(last, match.from))}<span class="${LIGATURE_CLASS}" title="${escapeHtml(match.source)}">${match.symbol}</span>`;
    last = match.to;
  }
  return html + escapeHtml(text.slice(last));
};

/** Length of a leading YAML front matter block (`---` … `---` or `...`), or 0. */
export const frontMatterLength = (markdown: string): number =>
  /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(markdown)?.[0].length ?? 0;
