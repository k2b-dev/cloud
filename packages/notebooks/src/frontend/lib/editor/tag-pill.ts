/**
 * Inline `#tag` pill widget — renders body-level tag references as
 * coloured pills in rich-mode. Click navigates to the tag-overview
 * page filtered to that tag.
 *
 * Disambiguation from headings: `# Title` (with space) is a heading;
 * `#tag` (no space, must start with letter) is a tag. Code blocks /
 * inline code / heading marks are excluded via the Lezer syntax tree
 * so neither documentation about the tag syntax nor `#define` macros
 * inside fenced code accidentally render as pills.
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range, Transaction } from "@codemirror/state";
import { RangeSet } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { type CursorZoneState, cursorZoneStateField, selectionIntersectsRange } from "./_lib/cursor-zone-field";
import { notebookWorkspaceMessages } from "../../[id]/messages";

/** Match `(start-of-line OR whitespace) #tag` — with `#tag` allowing nested
 *  `parent/child` and at least one letter as the first char to exclude
 *  `##` heading markers and `#42` numerals from matching. */
const TAG_REGEX = /(^|\s)#([a-zA-Z][\w-]*(?:\/[\w-]+)*)/g;

class TagWidget extends WidgetType {
  constructor(
    private notebookId: string,
    private tag: string,
  ) {
    super();
  }

  override toDOM() {
    const el = document.createElement("a");
    el.className =
      "cm-tag-pill inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 cursor-pointer hover:bg-emerald-100 dark:hover:bg-emerald-900/50 no-underline";
    el.href = `/app/notebooks/${this.notebookId}/tags/${encodeURIComponent(this.tag)}`;
    el.title = notebookWorkspaceMessages.resolve([document.documentElement.lang]).t.showNotesWithTag({ tag: this.tag });
    el.textContent = `#${this.tag}`;

    // Block CM cursor positioning — same pattern as note-link / file pill.
    el.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    el.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.location.assign(el.href);
    };
    return el;
  }

  override eq(other: WidgetType) {
    return other instanceof TagWidget && other.tag === this.tag && other.notebookId === this.notebookId;
  }

  override ignoreEvent() {
    return true;
  }
}

/** Walk the syntax tree once, collect ranges where tag-decoration must be
 *  skipped (any code, any heading marker). Used as the exclusion set when
 *  scanning the doc text for tag matches. */
const collectExcludedRanges = (state: EditorState): { from: number; to: number }[] => {
  const ranges: { from: number; to: number }[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      const name = node.type.name;
      if (name === "FencedCode" || name === "InlineCode" || name === "CodeBlock" || name === "HeaderMark") {
        ranges.push({ from: node.from, to: node.to });
      }
    },
  });
  return ranges;
};

const isInsideExcluded = (excluded: { from: number; to: number }[], from: number, to: number): boolean =>
  excluded.some((r) => from >= r.from && to <= r.to);

/** Source ranges of every `#tag` occurrence drive the cursor-zone
 *  rebuild gate — cursor moves through plain prose skip the full
 *  doc.toString() + matchAll() rescan because the key doesn't change.
 *  Doc changes are gated by `changesMightAffectTags` below — typing
 *  plain prose without `#` chars skips the rescan entirely. */
const findTags = (state: EditorState, notebookId: string): CursorZoneState => {
  const decorations: Range<Decoration>[] = [];
  const ranges: { from: number; to: number }[] = [];
  const cursor = state.selection.main;
  const excluded = collectExcludedRanges(state);
  const text = state.doc.toString();
  let hasSyntax = false;

  for (const m of text.matchAll(TAG_REGEX)) {
    // The match captures the leading whitespace (or empty for line-start)
    // in group 1, then the tag name in group 2. The `#tag` token starts
    // after the leading whitespace.
    const matchStart = m.index!;
    const leadingLen = m[1]!.length;
    const from = matchStart + leadingLen;
    const to = from + 1 + m[2]!.length; // `#` + tag chars

    if (isInsideExcluded(excluded, from, to)) continue;
    hasSyntax = true;
    ranges.push({ from, to });
    // Hide widget while cursor is inside its range so the user can edit
    // the literal `#tag` text without the pill swallowing clicks.
    if (selectionIntersectsRange(cursor, from, to)) continue;

    decorations.push(Decoration.replace({ widget: new TagWidget(notebookId, m[2]!.toLowerCase()) }).range(from, to));
  }
  return {
    decorations: decorations.length > 0 ? RangeSet.of(decorations, true) : Decoration.none,
    ranges,
    hasSyntax,
  };
};

/** Predicate for the incremental cursor-zone mode. Plain-prose
 *  keystrokes (no `#` in the inserted text or its ±2 char window)
 *  skip the full doc.toString + matchAll rescan. False positives
 *  (e.g. typing `#` in a URL fragment) just fall back to baseline. */
const changesMightAffectTags = (tr: Transaction): boolean => {
  let might = false;
  tr.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
    if (might) return;
    if (inserted.toString().includes("#")) {
      might = true;
      return;
    }
    const from = Math.max(0, fromB - 2);
    const to = Math.min(tr.state.doc.length, toB + 2);
    might = tr.state.doc.sliceString(from, to).includes("#");
  });
  return might;
};

export const tagPillExtension = (notebookId: string): Extension => {
  const stateField = cursorZoneStateField((state) => findTags(state, notebookId), { changesMightAffectSyntax: changesMightAffectTags });

  const theme = EditorView.theme({
    ".cm-tag-pill": {
      verticalAlign: "baseline",
      transition: "background-color 0.15s",
    },
  });

  return [stateField, theme];
};
