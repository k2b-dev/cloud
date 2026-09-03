/**
 * Autocomplete für ` ```language ` Code-Fences.
 *
 * Trigger: line starts with three backticks (or tildes) optionally
 * followed by a partial language name. Accepting a suggestion expands
 * to the full fenced block — opening fence with the chosen language,
 * a body line for the cursor, AND the closing fence — so the user
 * doesn't have to remember to close the fence themselves.
 *
 * Languages mirror exactly what `markdown.ts` registers as
 * `codeLanguages`, plus two notebooks-specific specials that get
 * their own rendering pipelines:
 *
 *  - `mermaid` — diagram, rendered via `mermaid.ts`
 *  - `math`   — block KaTeX, rendered via `katex.ts`
 *
 * Each suggestion ships an explicit Tabler `completionIcon` so the icon
 * column reads at a glance (`ti-brand-javascript`, `ti-database` for
 * SQL, `ti-math-function` for math, etc.) instead of falling through
 * to the generic `class` icon for every language.
 *
 * Scope: only in regular markdown context. We skip when the cursor
 * is already inside an existing `FencedCode` block — typing ` ``` `
 * to CLOSE a fence shouldn't surface the language picker.
 */
import { type Completion, type CompletionContext, type CompletionResult, snippetCompletion } from "@codemirror/autocomplete";
import { isInsideFencedCodeBody } from "./editor-scope";
import { withIcon } from "./completion-icon";

/**
 * Each fence-language entry. `name` is what we insert into the
 * source; `aliases` is shown as a hint for users who know the short
 * form ("js" → JavaScript). `icon` is a Tabler class.
 *
 * `bodyPlaceholder` lets us pre-fill the body for languages that
 * benefit from a starting template (mermaid would render an error
 * if you opened an empty diagram block — pre-filling a tiny example
 * gives instant visual feedback). For most languages the body
 * placeholder is empty so the user starts typing immediately.
 */
type FenceLang = {
  name: string;
  detail: string;
  aliases?: string[];
  icon: string;
  bodyPlaceholder?: string;
};

const LANGUAGES: FenceLang[] = [
  // Notebooks-specific specials — surface FIRST in the list because
  // they're the most distinctive feature of the editor, not generic
  // syntax-highlighted code.
  {
    name: "mermaid",
    detail: "Mermaid diagram",
    icon: "ti-binary-tree",
    bodyPlaceholder: "graph TD\n  A[Start] --> B[End]",
  },
  {
    name: "math",
    detail: "Block math (KaTeX)",
    icon: "ti-math-integral",
    bodyPlaceholder: "E = mc^2",
  },
  // Standard languages — alphabetical so users can scan.
  { name: "javascript", aliases: ["js"], detail: "JavaScript", icon: "ti-brand-javascript" },
  { name: "typescript", aliases: ["ts"], detail: "TypeScript", icon: "ti-brand-typescript" },
  { name: "python", aliases: ["py"], detail: "Python", icon: "ti-brand-python" },
  { name: "go", aliases: ["golang"], detail: "Go", icon: "ti-brand-golang" },
  { name: "rust", aliases: ["rs"], detail: "Rust", icon: "ti-brand-rust" },
  { name: "java", detail: "Java", icon: "ti-coffee" },
  { name: "cpp", aliases: ["c", "h", "hpp"], detail: "C / C++", icon: "ti-brand-cpp" },
  { name: "php", detail: "PHP", icon: "ti-brand-php" },
  { name: "sql", detail: "SQL", icon: "ti-database" },
  { name: "html", aliases: ["htm"], detail: "HTML", icon: "ti-brand-html5" },
  { name: "css", detail: "CSS", icon: "ti-brand-css3" },
  { name: "json", detail: "JSON", icon: "ti-braces" },
  { name: "yaml", aliases: ["yml"], detail: "YAML", icon: "ti-file-text" },
  { name: "xml", aliases: ["svg"], detail: "XML / SVG", icon: "ti-code" },
];

/** Build the snippet template for one language. Does NOT include
 *  the leading three backticks because the `from` position in the
 *  CompletionResult is anchored AFTER the backticks the user already
 *  typed — CM's prefix-filter compares the typed partial against
 *  `label` ("python", "javascript", …), and on acceptance only the
 *  text between `from` and the cursor is replaced. So we only emit
 *  the language tag + body + closing fence; the user's typed
 *  backticks stay in place. `${0}` parks the final cursor on the
 *  body line. */
const escapeSnippetPlaceholder = (value: string): string => value.replace(/[\\${}]/g, "\\$&");

const buildSnippet = (lang: FenceLang): string => {
  const body = lang.bodyPlaceholder ? `\${0:${escapeSnippetPlaceholder(lang.bodyPlaceholder)}}` : "${0}";
  return `${lang.name}\n${body}\n\`\`\``;
};

/** Pre-built completion list. Constant per editor — we don't allocate
 *  fresh snippet objects on every keystroke.
 *
 *  `boost`: numeric weight that CM adds to the option's relevance
 *  score. Mermaid and math receive a boost above generic languages.
 *
 *  We post-augment each Completion with `completionIcon` because
 *  `snippetCompletion`'s second-arg type is `Completion` (no
 *  `completionIcon` field on the official interface); the icon renderer
 *  in `slash-commands/index.ts` reads the field via a structural
 *  cast. */
const LANG_BOOSTS: Record<string, number> = {
  mermaid: 90,
  math: 80,
};

const COMPLETIONS: Completion[] = LANGUAGES.map((lang) => {
  const aliasHint = lang.aliases && lang.aliases.length > 0 ? ` · ${lang.aliases.join(", ")}` : "";
  const c = snippetCompletion(buildSnippet(lang), {
    label: lang.name,
    type: "namespace",
    detail: `${lang.detail}${aliasHint}`,
    boost: LANG_BOOSTS[lang.name],
  });
  withIcon(c, lang.icon);
  return c;
});

/**
 * Completion source. Wire into `autocompletion({override: […]})`.
 */
export const codeFenceCompletionSource = (context: CompletionContext): CompletionResult | null => {
  // matchBefore is anchored to the cursor: it returns a match only
  // if the regex matches text ending at the cursor. We want the
  // whole line text up to cursor to look like ` ```<partial> ` —
  // anything before triple-backticks (e.g. leading whitespace inside
  // a list item) would mean this isn't a top-level fence opener and
  // we shouldn't trigger.
  const word = context.matchBefore(/^(`{3,}|~{3,})\w*/);
  if (!word) return null;
  // Verify the match's `from` is at the line's `from` (paranoia —
  // the `^` in the regex should already enforce this, but matchBefore
  // operates on a substring so being explicit is cheap).
  const line = context.state.doc.lineAt(context.pos);
  if (word.from !== line.from) return null;
  // Don't surface when the cursor is INSIDE an existing fence body
  // (e.g. typing ` ``` ` on the closing line). We DO want the picker
  // on the opener line — `isInsideFencedCodeBody` returns false there.
  if (isInsideFencedCodeBody(context)) return null;
  // Count the fence chars (3+ backticks/tildes) so `from` lands
  // AFTER them. matchBefore captured the entire opener including
  // any partial language name; we need to find where the fence
  // marker ends and the language name begins. The match.text
  // begins with ≥3 of the same char (backticks OR tildes) — count
  // those and offset `from` accordingly.
  const text = word.text;
  let fenceLen = 0;
  const fenceChar = text[0]!;
  while (fenceLen < text.length && text[fenceLen] === fenceChar) fenceLen++;
  return {
    from: word.from + fenceLen,
    to: word.to,
    options: COMPLETIONS,
    // `validFor` keeps the popup open while the user continues
    // typing alphanumeric chars after the backticks — checked
    // against text from `from` to cursor, which is just the
    // language-name fragment (e.g. "py" → "python").
    validFor: /^\w*$/,
  };
};
