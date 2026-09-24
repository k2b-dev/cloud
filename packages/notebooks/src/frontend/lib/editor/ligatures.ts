/**
 * Display ligatures for the rich editor: `->` shows as `→`, `!=` as `≠` and
 * so on (see `lib/ligatures.ts`). The document text never changes. A
 * sequence shows its typed characters again while the selection touches it,
 * the same way hidden Markdown marks reappear.
 *
 * Only visible ranges are scanned. The Markdown syntax tree decides what is
 * prose; code, HTML, URLs, links, marks and table rules are skipped. Notebook
 * syntax that the tree does not model (math, data, query and TOC blocks, YAML
 * front matter) is resolved once per document version, and only when a
 * visible candidate needs it.
 */
import { syntaxTree } from "@codemirror/language";
import { type Text as DocText, type EditorState, type Extension, Prec, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { findLigatures, frontMatterLength, type LigatureMatch } from "../../../lib/ligatures";
import { extractDataBlocks } from "../../../lib/named-blocks";
import { extractNotebookDirectiveRanges } from "../../../lib/query-blocks";
import { refreshMarkdownDecorationsEffect } from "./_lib/cursor-zone-field";
import { blockMathPattern, inlineMathPattern } from "./_lib/math-syntax";

type Span = { from: number; to: number };

/** Syntax-tree nodes whose text is never prose. Children are not visited. */
const EXCLUDED_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "HTMLBlock",
  "HTMLTag",
  "Comment",
  "CommentBlock",
  "ProcessingInstruction",
  "ProcessingInstructionBlock",
  "URL",
  "Autolink",
  "Link",
  "Image",
  "LinkReference",
  "Escape",
  "HorizontalRule",
  "TableDelimiter",
  "HeaderMark",
  "QuoteMark",
  "ListMark",
  "EmphasisMark",
  "StrikethroughMark",
  "TaskMarker",
]);

const overlaps = (spans: readonly Span[], from: number, to: number): boolean => spans.some((span) => from < span.to && to > span.from);

const notebookSyntaxCache = new WeakMap<DocText, Span[]>();

/** Math, data, query and TOC blocks and front matter: whole-document syntax, cached per document version. */
const notebookSyntax = (doc: DocText): Span[] => {
  const cached = notebookSyntaxCache.get(doc);
  if (cached) return cached;
  const markdown = doc.toString();
  const spans: Span[] = [];
  const frontMatter = frontMatterLength(markdown);
  if (frontMatter) spans.push({ from: 0, to: frontMatter });
  if (markdown.includes("$") || markdown.includes("\\")) {
    for (const pattern of [blockMathPattern(), inlineMathPattern()]) {
      for (const match of markdown.matchAll(pattern)) spans.push({ from: match.index, to: match.index + match[0].length });
    }
  }
  for (const block of extractDataBlocks(markdown)) spans.push({ from: block.blockStart, to: block.blockEnd });
  for (const block of extractNotebookDirectiveRanges(markdown)) spans.push({ from: block.from, to: block.to });
  notebookSyntaxCache.set(doc, spans);
  return spans;
};

/** Ligature candidates in the visible prose. */
const findVisibleLigatures = (view: EditorView): LigatureMatch[] => {
  const { state } = view;
  const matches: LigatureMatch[] = [];
  for (const visible of view.visibleRanges) {
    const excluded: Span[] = [];
    syntaxTree(state).iterate({
      from: visible.from,
      to: visible.to,
      enter: (node) => {
        if (!EXCLUDED_NODES.has(node.name)) return;
        excluded.push({ from: node.from, to: node.to });
        return false;
      },
    });
    for (let position = visible.from; position <= visible.to; ) {
      const line = state.doc.lineAt(position);
      const from = Math.max(line.from, visible.from) - line.from;
      const to = Math.min(line.to, visible.to) - line.from;
      for (const match of findLigatures(line.text, from, to)) {
        const found = { ...match, from: match.from + line.from, to: match.to + line.from };
        if (!overlaps(excluded, found.from, found.to)) matches.push(found);
      }
      position = line.to + 1;
    }
  }
  if (matches.length === 0) return matches;
  const notebook = notebookSyntax(state.doc);
  return matches.filter((match) => !overlaps(notebook, match.from, match.to));
};

/** Same rule as hidden Markdown marks: a selection that touches the sequence reveals it. */
const touched = (state: EditorState, match: LigatureMatch): boolean =>
  state.selection.ranges.some((range) => range.from <= match.to && range.to >= match.from);

const touchedKey = (state: EditorState, matches: readonly LigatureMatch[]): string =>
  matches.flatMap((match, index) => (touched(state, match) ? [index] : [])).join(",");

class LigatureWidget extends WidgetType {
  constructor(private readonly symbol: string) {
    super();
  }

  override eq(other: WidgetType) {
    return other instanceof LigatureWidget && other.symbol === this.symbol;
  }

  override toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ligature";
    span.textContent = this.symbol;
    return span;
  }

  /** Let the editor place the cursor on click, which then reveals the typed characters. */
  override ignoreEvent() {
    return false;
  }
}

const widgets = new Map<string, Decoration>();
const ligatureDecoration = (symbol: string): Decoration => {
  let decoration = widgets.get(symbol);
  if (!decoration) {
    decoration = Decoration.replace({ widget: new LigatureWidget(symbol) });
    widgets.set(symbol, decoration);
  }
  return decoration;
};

const decorate = (state: EditorState, matches: readonly LigatureMatch[]): DecorationSet => {
  const ranges: Range<Decoration>[] = [];
  for (const match of matches) {
    if (!touched(state, match)) ranges.push(ligatureDecoration(match.symbol).range(match.from, match.to));
  }
  return Decoration.set(ranges, true);
};

/** Highest precedence: only marks of lower precedence, such as syntax highlighting, wrap a replaced widget, so the symbol keeps heading and emphasis styling. */
export const ligaturesExtension = (): Extension =>
  Prec.highest(
    ViewPlugin.fromClass(
      class {
        matches: LigatureMatch[];
        key: string;
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.matches = findVisibleLigatures(view);
          this.key = touchedKey(view.state, this.matches);
          this.decorations = decorate(view.state, this.matches);
        }

        update(update: ViewUpdate) {
          const rescan =
            update.docChanged ||
            update.viewportChanged ||
            syntaxTree(update.startState) !== syntaxTree(update.state) ||
            update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshMarkdownDecorationsEffect)));
          if (rescan) this.matches = findVisibleLigatures(update.view);
          else if (!update.selectionSet) return;
          const key = touchedKey(update.state, this.matches);
          if (!rescan && key === this.key) return;
          this.key = key;
          this.decorations = decorate(update.state, this.matches);
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
  );

const LIGATURE_SKIP = "code, pre, a, time, .katex, .md-formula-ok, .md-formula-error";

/**
 * Applies the same display ligatures to prose inside a rendered widget (notice
 * cards, table previews), so they match the editor text and the Book.
 */
export const applyLigatures = (root: HTMLElement): void => {
  const textNodes = (node: Node): ChildNode[] =>
    Array.from(node.childNodes).flatMap((child) =>
      child.nodeType !== child.TEXT_NODE ? textNodes(child) : child.parentElement?.closest(LIGATURE_SKIP) ? [] : [child],
    );
  for (const node of textNodes(root)) {
    const text = node.textContent ?? "";
    const matches = findLigatures(text);
    if (matches.length === 0) continue;
    const parts: Array<string | HTMLElement> = [];
    let last = 0;
    for (const match of matches) {
      const span = root.ownerDocument.createElement("span");
      span.className = "cm-ligature";
      span.title = match.source;
      span.textContent = match.symbol;
      parts.push(text.slice(last, match.from), span);
      last = match.to;
    }
    // One wrapper keeps the text a single item in flex containers such as table cells.
    const wrapper = root.ownerDocument.createElement("span");
    wrapper.append(...parts, text.slice(last));
    node.replaceWith(wrapper);
  }
};
