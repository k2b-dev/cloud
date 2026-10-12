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
 * The lines the note editor shows when it mounts, with the caret at the start,
 * and the styles that size them. Rich mode reproduces headings, emphasis and
 * code and ends before the first line the editor draws otherwise (lists, links,
 * tags, ligatures, blocks and other widgets): those lines arrive with the
 * editor, below the preview, so no text moves. Source mode returns every line.
 */
export const notePreviewLines = (markdown: string, mode: "rich" | "source"): NotePreviewLine[] => {
  // EditorState normalizes every supported line separator to LF.
  const text = markdown.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (mode === "source") return lines.map((line) => ({ parts: line ? [line] : [] }));

  const tree = markdownLanguage.parser.parse(text);
  const code: Range[] = [];
  const headerMarks: Range[] = [];
  const hidden: Range[] = [];
  const styled: StyledRange[] = [];
  let cut = frontMatterLength(text) ? 0 : text.length + 1;
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
      if (!inside(code, match.index, match.index + match[0].length)) cut = Math.min(cut, match.index);
    }
  }
  // These extensions currently scan code too; keep their existing behavior.
  for (const pattern of [MARK_REGEX, SUB_REGEX, SUP_REGEX]) {
    for (const match of text.matchAll(pattern)) cut = Math.min(cut, match.index);
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
    if (line.search(SPECIAL_CHAR_REGEX) >= 0) cut = Math.min(cut, from);
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
  let stack: { range: StyledRange; children: NotePreviewPart[] }[] = [];
  for (let index = 0; index < edges.length - 1; index++) {
    const start = edges[index]!;
    const end = edges[index + 1]!;
    if (inside(removed, start, end)) continue;
    const active = ranges.filter((range) => range.from <= start && range.to >= end);
    let shared = 0;
    while (shared < stack.length && stack[shared]?.range === active[shared]) shared++;
    stack = stack.slice(0, shared);
    for (const range of active.slice(shared)) {
      const children: NotePreviewPart[] = [];
      (stack.at(-1)?.children ?? parts).push({ className: range.className, children });
      stack.push({ range, children });
    }
    (stack.at(-1)?.children ?? parts).push(text.slice(start, end));
  }
  return parts;
};
