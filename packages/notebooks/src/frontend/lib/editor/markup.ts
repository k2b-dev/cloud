/**
 * Markup-hiding extension for CodeMirror.
 *
 * Hides markdown syntax markers when the cursor is not on the same line/range:
 * - Heading markers (# ## ### etc.) — hidden when cursor is on a different line
 * - Bold markers (**) — hidden when cursor is outside the bold range
 * - Italic markers (* or _) — hidden when cursor is outside the italic range
 * - Strikethrough markers (~~) — hidden when cursor is outside the range
 *
 * Also renders horizontal rules (--- / *** / ___) as visual lines.
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { RangeSet, StateField } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { treeOrDocChanged } from "./_lib/cursor-zone-field";

// =============================================================================
// Widgets
// =============================================================================

class HorizontalRuleWidget extends WidgetType {
  constructor(private fromPos: number) {
    super();
  }

  override toDOM(view: EditorView) {
    const hr = document.createElement("div");
    hr.className = "cm-hr-widget";
    hr.setAttribute("contenteditable", "false");
    hr.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.fromPos }, scrollIntoView: true });
      view.focus();
    };
    return hr;
  }

  override eq(other: WidgetType) {
    return other instanceof HorizontalRuleWidget && other.fromPos === this.fromPos;
  }

  override ignoreEvent() {
    return true;
  }
}

// =============================================================================
// Decoration builders
// =============================================================================

/**
 * Check if the cursor is on a given line.
 */
const cursorOnLine = (state: EditorState, lineFrom: number, lineTo: number): boolean => {
  for (const range of state.selection.ranges) {
    const rLineFrom = state.doc.lineAt(range.from).number;
    const rLineTo = state.doc.lineAt(range.to).number;
    const targetLineFrom = state.doc.lineAt(lineFrom).number;
    const targetLineTo = state.doc.lineAt(lineTo).number;
    if (rLineFrom <= targetLineTo && rLineTo >= targetLineFrom) return true;
  }
  return false;
};

/**
 * Check if the cursor is inside a range (inclusive).
 */
const cursorInRange = (state: EditorState, from: number, to: number): boolean => {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
};

/**
 * Collect all code ranges to avoid decorating inside code blocks.
 */
const getCodeRanges = (state: EditorState): { from: number; to: number }[] => {
  const ranges: { from: number; to: number }[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.type.name === "FencedCode" || node.type.name === "InlineCode" || node.type.name === "CodeBlock") {
        ranges.push({ from: node.from, to: node.to });
      }
    },
  });
  return ranges;
};

const isInsideCode = (codeRanges: { from: number; to: number }[], from: number, to: number): boolean =>
  codeRanges.some((r) => from >= r.from && to <= r.to);

/**
 * Walk the syntax tree once to collect:
 *   - Line numbers of every line that hosts a heading / HR
 *     (cursor-on-line decisions depend on these).
 *   - Source ranges of every emphasis / strong / strikethrough /
 *     codespan node (cursor-in-range decisions depend on these).
 *
 * Cached in the StateField value so subsequent selection-only
 * transactions can decide whether to rebuild WITHOUT another
 * walk: if the cursor neither changed lines (for line-based
 * decorations) nor crossed any tracked range boundary (for
 * range-based decorations), nothing's changed and we keep the
 * existing decoration set.
 */
const collectMarkupTrackedRanges = (state: EditorState): { lines: Set<number>; ranges: Array<{ from: number; to: number }> } => {
  const lines = new Set<number>();
  const ranges: Array<{ from: number; to: number }> = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      const { name, from, to } = node;
      if (name.startsWith("ATXHeading") || name === "HorizontalRule" || name === "SetextHeading") {
        const fromLine = state.doc.lineAt(from).number;
        const toLine = state.doc.lineAt(to).number;
        for (let l = fromLine; l <= toLine; l++) lines.add(l);
        return;
      }
      if (name === "Emphasis" || name === "StrongEmphasis" || name === "Strikethrough" || name === "InlineCode") {
        ranges.push({ from, to });
      }
    },
  });
  return { lines, ranges };
};

/**
 * Build all decorations for markup hiding and horizontal rules.
 */
const buildDecorations = (state: EditorState): Range<Decoration>[] => {
  const decorations: Range<Decoration>[] = [];
  const codeRanges = getCodeRanges(state);

  syntaxTree(state).iterate({
    enter: (node) => {
      const { name, from, to } = node;

      // ---------------------------------------------------------------
      // Headings: hide the "# " marker when cursor is on another line
      // ---------------------------------------------------------------
      if (name.startsWith("ATXHeading")) {
        if (isInsideCode(codeRanges, from, to)) return;
        if (cursorOnLine(state, from, to)) return;

        // Find the HeaderMark node (the # characters)
        let markEnd = from;
        const nodeRef = node.node;
        const markCursor = nodeRef.cursor();
        if (markCursor.firstChild()) {
          do {
            if (markCursor.name === "HeaderMark") {
              // Include the space after the #
              markEnd = markCursor.to;
              const afterMark = state.doc.sliceString(markEnd, markEnd + 1);
              if (afterMark === " ") markEnd++;
              break;
            }
          } while (markCursor.nextSibling());
        }

        if (markEnd > from) {
          decorations.push(Decoration.replace({}).range(from, markEnd));
        }
        return;
      }

      // ---------------------------------------------------------------
      // Bold: hide ** or __ markers
      // ---------------------------------------------------------------
      if (name === "StrongEmphasis") {
        if (isInsideCode(codeRanges, from, to)) return;
        if (cursorInRange(state, from, to)) return;

        const text = state.doc.sliceString(from, to);
        const marker = text.startsWith("**") ? "**" : text.startsWith("__") ? "__" : null;
        if (!marker) return;

        const markerLen = marker.length;
        // Hide opening marker
        decorations.push(Decoration.replace({}).range(from, from + markerLen));
        // Hide closing marker
        decorations.push(Decoration.replace({}).range(to - markerLen, to));
        return;
      }

      // ---------------------------------------------------------------
      // Italic: hide * or _ markers
      // ---------------------------------------------------------------
      if (name === "Emphasis") {
        if (isInsideCode(codeRanges, from, to)) return;
        if (cursorInRange(state, from, to)) return;

        const text = state.doc.sliceString(from, to);
        const marker = text.startsWith("*") ? "*" : text.startsWith("_") ? "_" : null;
        if (!marker) return;

        const markerLen = marker.length;
        // Hide opening marker
        decorations.push(Decoration.replace({}).range(from, from + markerLen));
        // Hide closing marker
        decorations.push(Decoration.replace({}).range(to - markerLen, to));
        return;
      }

      // ---------------------------------------------------------------
      // Strikethrough: hide ~~ markers
      // ---------------------------------------------------------------
      if (name === "Strikethrough") {
        if (isInsideCode(codeRanges, from, to)) return;
        if (cursorInRange(state, from, to)) return;

        // Hide opening ~~
        decorations.push(Decoration.replace({}).range(from, from + 2));
        // Hide closing ~~
        decorations.push(Decoration.replace({}).range(to - 2, to));
        return;
      }

      // ---------------------------------------------------------------
      // Horizontal Rule: replace --- / *** / ___ with a visual line
      // ---------------------------------------------------------------
      if (name === "HorizontalRule") {
        if (cursorOnLine(state, from, to)) return;

        decorations.push(
          Decoration.replace({
            widget: new HorizontalRuleWidget(from),
            block: true,
          }).range(from, to),
        );
        return;
      }
    },
  });

  return decorations;
};

const buildAtomicDecorations = (state: EditorState): Range<Decoration>[] => {
  const decorations: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: ({ name, from, to }) => {
      if (name !== "HorizontalRule") return;
      if (cursorOnLine(state, from, to)) return;
      decorations.push(
        Decoration.replace({
          widget: new HorizontalRuleWidget(from),
          block: true,
        }).range(from, to),
      );
    },
  });
  return decorations;
};

// =============================================================================
// Extension
// =============================================================================

/** All decoration-affecting ranges discovered during the last
 *  rebuild. Markup makes two kinds of cursor-sensitive decisions:
 *
 *   - LINE-BASED (`cursorOnLine`): headings + HRs. Rebuild needed
 *     when the cursor moves to a different line.
 *
 *   - RANGE-BASED (`cursorInRange`): emphasis / strong markers.
 *     Rebuild needed when the cursor's containment status changes
 *     for any tracked range (entered or left any of them).
 *
 *  We cache both so the `update()` can decide whether to rebuild
 *  by comparing the new cursor's relationship to these ranges
 *  against the old state's. */
type MarkupState = {
  decorations: DecorationSet;
  atomicDecorations: DecorationSet;
  /** Line numbers of every line that has a cursor-sensitive
   *  decoration (heading, HR). If the cursor crosses any of these
   *  lines, we rebuild. */
  cursorSensitiveLines: Set<number>;
  /** Emphasis / strong ranges — decisions depend on `cursorInRange`. */
  cursorSensitiveRanges: Array<{ from: number; to: number }>;
  /** Cached current cursor signature so we can compare across
   *  transactions cheaply. */
  cursorLine: number;
  cursorRangeKey: string;
};

const cursorLineNumber = (state: EditorState): number => state.doc.lineAt(state.selection.main.head).number;

/** Compact "set of ranges the cursor is inside" identifier. We use
 *  a sorted comma-separated index string so equality is a cheap
 *  string compare. */
const computeCursorRangeKey = (state: EditorState, ranges: Array<{ from: number; to: number }>): string => {
  const cursor = state.selection.main;
  const hits: number[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]!;
    if (cursor.from <= r.to && cursor.to >= r.from) hits.push(i);
  }
  return hits.join(",");
};

export const markupExtension = (): Extension => {
  const stateField = StateField.define<MarkupState>({
    create(state) {
      const tracked = collectMarkupTrackedRanges(state);
      return {
        decorations: RangeSet.of(buildDecorations(state), true),
        atomicDecorations: RangeSet.of(buildAtomicDecorations(state), true),
        cursorSensitiveLines: tracked.lines,
        cursorSensitiveRanges: tracked.ranges,
        cursorLine: cursorLineNumber(state),
        cursorRangeKey: computeCursorRangeKey(state, tracked.ranges),
      };
    },
    update(value, tr) {
      if (treeOrDocChanged(tr)) {
        // Doc or syntax tree changed — full rebuild. Track ranges anew.
        const tracked = collectMarkupTrackedRanges(tr.state);
        return {
          decorations: RangeSet.of(buildDecorations(tr.state), true),
          atomicDecorations: RangeSet.of(buildAtomicDecorations(tr.state), true),
          cursorSensitiveLines: tracked.lines,
          cursorSensitiveRanges: tracked.ranges,
          cursorLine: cursorLineNumber(tr.state),
          cursorRangeKey: computeCursorRangeKey(tr.state, tracked.ranges),
        };
      }
      if (!tr.selection) {
        return value;
      }
      // Selection moved. Two checks:
      //   1. Cursor changed line AND old or new line had a markup
      //      decoration (heading / HR). Rebuild.
      //   2. Cursor crossed an emphasis/strong range boundary
      //      (entered or left). Rebuild.
      const newLine = cursorLineNumber(tr.state);
      const lineChangedAndMatters =
        newLine !== value.cursorLine && (value.cursorSensitiveLines.has(value.cursorLine) || value.cursorSensitiveLines.has(newLine));
      const newRangeKey = computeCursorRangeKey(tr.state, value.cursorSensitiveRanges);
      const rangesChanged = newRangeKey !== value.cursorRangeKey;
      if (!lineChangedAndMatters && !rangesChanged) {
        // Selection moved but didn't affect any markup decision —
        // skip the rebuild. This is the common case for typing
        // within a plain paragraph: lots of cursor moves with no
        // decoration impact.
        return { ...value, cursorLine: newLine };
      }
      const tracked = collectMarkupTrackedRanges(tr.state);
      return {
        decorations: RangeSet.of(buildDecorations(tr.state), true),
        atomicDecorations: RangeSet.of(buildAtomicDecorations(tr.state), true),
        cursorSensitiveLines: tracked.lines,
        cursorSensitiveRanges: tracked.ranges,
        cursorLine: newLine,
        cursorRangeKey: computeCursorRangeKey(tr.state, tracked.ranges),
      };
    },
    provide(field) {
      return [
        EditorView.decorations.from(field, (v) => v.decorations),
        EditorView.atomicRanges.of((view) => view.state.field(field).atomicDecorations),
      ];
    },
  });

  const theme = EditorView.theme({
    ".cm-hr-widget": {
      borderTop: "2px solid",
      borderColor: "var(--color-zinc-300)",
      margin: "0 !important",
      padding: "0.75em 0 0",
      boxSizing: "border-box",
    },
    ".dark .cm-hr-widget": {
      borderColor: "var(--color-zinc-600)",
    },
  });

  return [stateField, theme];
};
