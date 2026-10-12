import { markdownLanguage } from "@codemirror/lang-markdown";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { findLigatures, frontMatterLength } from "../../../../lib/ligatures";
import { NOTEBOOK_DIRECTIVE_START } from "../../../../lib/markdown-context";
import { codeFenceLanguage } from "../../../../lib/markdown-fences";
import { isNamedBlockHandle } from "../../../../lib/named-blocks";
import { MARK_REGEX, SPECIAL_CHAR_REGEX, SUB_REGEX, SUP_REGEX, TAG_REGEX } from "../../../lib/editor/_lib/inline-syntax";
import { blockMathPattern, inlineMathPattern } from "../../../lib/editor/_lib/math-syntax";

export const NOTE_PREVIEW_ID = "notebook-note-preview";
export type NotePreviewPart = string | { className: string; children: NotePreviewPart[] };
export type NotePreviewLine = { parts: NotePreviewPart[] };

type Range = { from: number; to: number };
type StyledRange = Range & { className: string; order: number };
const prefix = "notebook-note-preview__";
const allowedNodes = new Set([
  "Document",
  "Paragraph",
  "HeaderMark",
  "Emphasis",
  "StrongEmphasis",
  "EmphasisMark",
  "Strikethrough",
  "StrikethroughMark",
  "InlineCode",
  "CodeMark",
  "FencedCode",
  "CodeInfo",
  "CodeText",
  "CodeBlock",
  ...Array.from({ length: 6 }, (_, index) => `ATXHeading${index + 1}`),
  "SetextHeading1",
  "SetextHeading2",
]);
const highlighter = tagHighlighter([
  { tag: tags.strong, class: `${prefix}strong` },
  { tag: tags.emphasis, class: `${prefix}emphasis` },
  { tag: tags.strikethrough, class: `${prefix}strike` },
  { tag: tags.meta, class: `${prefix}meta` },
]);
/** Whether one of `ranges`, sorted and not nested, contains from–to. */
const inside = (ranges: Range[], from: number, to: number) => {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (ranges[middle]!.from <= from) low = middle + 1;
    else high = middle - 1;
  }
  const range = ranges[high];
  return !!range && to <= range.to;
};

/**
 * At most what CodeMirror draws when it mounts: the viewport and up to 1000 px around it. On a screen 2160 px tall
 * (4K at 100 %) that is 162 lines at the editor's smallest line height, 19.6 px in source mode. 16 KiB fills more than
 * that in the reading column (16 KiB of prose: at least 5,900 px), so it bounds only long lines. Past the budget, a
 * long note would add only HTML that a phone parses before the editor can start; those lines arrive with the editor,
 * like lines past a cut.
 */
export const NOTE_PREVIEW_BUDGET = { lines: Math.ceil((2160 + 1000) / 19.6), characters: 16 * 1024 };

/**
 * The lines the note editor shows when it mounts, with the caret at the start,
 * and the styles that size them, within the budget. Rich mode reproduces
 * headings, emphasis and code and ends before the first line the editor draws
 * otherwise (lists, links, tags, ligatures, blocks and other widgets): those
 * lines arrive with the editor, below the preview, so no text moves.
 */
export const notePreviewLines = (markdown: string, mode: "rich" | "source", budget = NOTE_PREVIEW_BUDGET): NotePreviewLine[] => {
  // EditorState normalizes every supported line separator to LF.
  const text = markdown.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  let count = 0;
  let end = 0;
  while (count < Math.min(lines.length, budget.lines) && end + lines[count]!.length <= budget.characters) {
    end += lines[count]!.length + 1;
    count++;
  }
  if (mode === "source") return lines.slice(0, count).map((line) => ({ parts: line ? [line] : [] }));

  let cut = frontMatterLength(text) ? 0 : count < lines.length ? end : text.length + 1;
  // These extensions currently scan code too; keep their existing behavior.
  for (const pattern of [MARK_REGEX, SUB_REGEX, SUP_REGEX]) {
    for (const match of text.matchAll(pattern)) cut = Math.min(cut, match.index);
  }
  let lineFrom = 0;
  for (const line of lines) {
    if (lineFrom >= cut) break;
    if (line.search(SPECIAL_CHAR_REGEX) >= 0) cut = Math.min(cut, lineFrom);
    lineFrom += line.length + 1;
  }
  if (cut === 0) return [];

  // Parse to the first blank line after the cut, where block lookahead (setext, tables and paragraph inlines) stops,
  // so every line before the cut gets the nodes that a parse of the whole note gives it. Markdown counts only spaces
  // and tabs as blank. Code may run on past that line; lists, quotes and HTML already cut at their start.
  const blank = /\n[ \t]*\n/g;
  blank.lastIndex = cut;
  const tree = markdownLanguage.parser.parse(text.slice(0, blank.exec(text)?.index ?? text.length));
  const code: Range[] = [];
  const headerMarks: Range[] = [];
  const hidden: Range[] = [];
  const styled: StyledRange[] = [];
  tree.iterate({
    enter(node) {
      const { name, from, to } = node;
      if (!allowedNodes.has(name)) cut = Math.min(cut, from);
      if (name === "HeaderMark") headerMarks.push({ from, to });
      if (name === "InlineCode" || name === "FencedCode" || name === "CodeBlock") {
        code.push({ from, to });
        styled.push({ from, to, className: `${prefix}code${name === "InlineCode" ? "" : ` ${prefix}code-block`}`, order: 1 });
        if (name === "FencedCode" && ["mermaid", "math"].includes(codeFenceLanguage(text.slice(from, to).split("\n")[0] ?? ""))) {
          cut = Math.min(cut, from);
        }
      }
      if (name.startsWith("ATXHeading") || name.startsWith("SetextHeading")) {
        styled.push({ from, to, className: `${prefix}heading-${name.at(-1)}`, order: 0 });
        if (name.startsWith("ATXHeading") && text.lastIndexOf("\n", from - 1) >= 0) {
          const mark = node.node.getChild("HeaderMark");
          if (mark) hidden.push({ from, to: mark.to + (text[mark.to] === " " ? 1 : 0) });
        }
      }
      if (from > 0 && (name === "StrongEmphasis" || name === "Emphasis" || name === "Strikethrough")) {
        const size = name === "Emphasis" ? 1 : 2;
        hidden.push({ from, to: from + size }, { from: to - size, to });
      }
    },
  });
  highlightTree(tree, highlighter, (from, to, className) => styled.push({ from, to, className, order: 2 }));

  for (const match of text.matchAll(TAG_REGEX)) {
    const from = match.index + (match[1]?.length ?? 0);
    const to = match.index + match[0].length;
    if (!inside(code, from, to) && !inside(headerMarks, from, to)) cut = Math.min(cut, from);
  }
  for (const pattern of [blockMathPattern(), inlineMathPattern()]) {
    for (const match of text.matchAll(pattern)) {
      // The code the parse ends in may run on in the note, so block math leaving it cuts there: only a shorter preview.
      if (!inside(code, match.index, match.index + match[0].length)) cut = Math.min(cut, match.index);
    }
  }
  for (const match of findLigatures(text)) {
    if (!inside(code, match.from, match.to)) cut = Math.min(cut, match.from);
  }

  // One pass over the lines: each line sees only the ranges that reach it, so a long note stays linear.
  styled.sort((a, b) => a.from - b.from);
  hidden.sort((a, b) => a.from - b.from);
  let styledOnLine: StyledRange[] = [];
  let hiddenOnLine: Range[] = [];
  let nextStyled = 0;
  let nextHidden = 0;
  const result: NotePreviewLine[] = [];
  let from = 0;
  for (const line of lines) {
    const to = from + line.length;
    if (!inside(code, from, to) && (NOTEBOOK_DIRECTIVE_START.test(line) || isNamedBlockHandle(line))) cut = Math.min(cut, from);
    if (cut <= to) break;
    styledOnLine = styledOnLine.filter((range) => range.to > from);
    for (; nextStyled < styled.length && styled[nextStyled]!.from < to; nextStyled++) styledOnLine.push(styled[nextStyled]!);
    hiddenOnLine = hiddenOnLine.filter((range) => range.to > from);
    for (; nextHidden < hidden.length && hidden[nextHidden]!.from < to; nextHidden++) hiddenOnLine.push(hidden[nextHidden]!);
    result.push({ parts: lineParts(text, from, to, styledOnLine, hiddenOnLine) });
    from = to + 1;
  }
  return result;
};

const lineParts = (text: string, from: number, to: number, styled: StyledRange[], hidden: Range[]): NotePreviewPart[] => {
  const ranges = styled.filter((range) => range.to > from).sort((a, b) => a.order - b.order || a.from - b.from);
  const removed = hidden.filter((range) => range.to > from);
  const edges = [
    ...new Set([from, to, ...[...ranges, ...removed].flatMap((range) => [Math.max(from, range.from), Math.min(to, range.to)])]),
  ].sort((a, b) => a - b);
  const parts: NotePreviewPart[] = [];
  const starts = ranges.map((range, rank) => ({ range, rank })).sort((a, b) => a.range.from - b.range.from);
  const ends = [...starts].sort((a, b) => a.range.to - b.range.to);
  // At most one heading, one code range and one highlight overlap.
  const active: typeof starts = [];
  let nextStart = 0;
  let nextEnd = 0;
  let nextRemoved = 0;
  let stack: { range: StyledRange; children: NotePreviewPart[] }[] = [];
  for (let index = 0; index < edges.length - 1; index++) {
    const start = edges[index]!;
    const end = edges[index + 1]!;
    for (; nextStart < starts.length && starts[nextStart]!.range.from <= start; nextStart++) {
      const entry = starts[nextStart]!;
      let low = 0;
      let high = active.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (active[middle]!.rank < entry.rank) low = middle + 1;
        else high = middle;
      }
      active.splice(low, 0, entry);
    }
    for (; nextEnd < ends.length && ends[nextEnd]!.range.to <= start; nextEnd++) {
      active.splice(active.indexOf(ends[nextEnd]!), 1);
    }
    // Hidden marks can overlap: keep the last start, just like inside().
    while (nextRemoved < removed.length && removed[nextRemoved]!.from <= start) nextRemoved++;
    if (nextRemoved > 0 && removed[nextRemoved - 1]!.to >= end) continue;
    let shared = 0;
    while (shared < stack.length && stack[shared]?.range === active[shared]?.range) shared++;
    stack = stack.slice(0, shared);
    for (const { range } of active.slice(shared)) {
      const children: NotePreviewPart[] = [];
      (stack.at(-1)?.children ?? parts).push({ className: range.className, children });
      stack.push({ range, children });
    }
    (stack.at(-1)?.children ?? parts).push(text.slice(start, end));
  }
  return parts;
};
