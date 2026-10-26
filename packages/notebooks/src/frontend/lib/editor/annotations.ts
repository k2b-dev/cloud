import { type ChangeSet, type EditorState, type Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

/**
 * Inline comments in the note editor: the commented passages in each author's color, the dot of a comment whose
 * passage was deleted, the passage someone is writing a comment for, and the preview of an accepted suggestion. The
 * comments themselves live in Notebooks; the editor only draws where they are and maps them through edits.
 */

/** One comment's place in the editor's text. */
export type AnnotationMark = {
  id: string;
  from: number;
  to: number;
  /** The author's person color. */
  color: string;
  /** Resolved and accepted comments draw gray, and only while resolved comments are shown. */
  resolved: boolean;
  /** The passage was deleted: the comment stays as a dot at `from`. */
  orphan: boolean;
  /** What a screen reader hears on the passage, such as "Commented by Mara Keller". */
  label: string;
};

export type AnnotationFocus = { hover: string | null; active: string | null };
export type AnnotationPreview = { id: string; insert: string } | null;
export type AnnotationDraft = { from: number; to: number; color: string } | null;

type AnnotationState = {
  marks: AnnotationMark[];
  focus: AnnotationFocus;
  preview: AnnotationPreview;
  draft: AnnotationDraft;
};

export const setAnnotations = StateEffect.define<AnnotationMark[]>();
export const setAnnotationFocus = StateEffect.define<Partial<AnnotationFocus>>();
export const setAnnotationPreview = StateEffect.define<AnnotationPreview>();
export const setAnnotationDraft = StateEffect.define<AnnotationDraft>();

/** A start sticks to the first character and an end to the last, so typing at the edges does not widen a passage. */
const mapMark = (mark: AnnotationMark, changes: ChangeSet): AnnotationMark => {
  const from = changes.mapPos(mark.from, 1);
  const to = changes.mapPos(mark.to, -1);
  if (mark.orphan || to > from) return { ...mark, from, to: Math.max(from, to) };
  // Everything the passage held was deleted: the comment keeps a dot where it stood.
  const at = changes.mapPos(mark.from, -1);
  return { ...mark, from: at, to: at, orphan: true };
};

const annotationField = StateField.define<AnnotationState>({
  create: () => ({ marks: [], focus: { hover: null, active: null }, preview: null, draft: null }),
  update(value, tr) {
    let next = value;
    if (tr.docChanged) {
      const draft = next.draft && { ...next.draft, from: tr.changes.mapPos(next.draft.from, 1), to: tr.changes.mapPos(next.draft.to, -1) };
      next = { ...next, marks: next.marks.map((mark) => mapMark(mark, tr.changes)), draft: draft && draft.to > draft.from ? draft : null };
    }
    for (const effect of tr.effects) {
      if (effect.is(setAnnotations)) {
        const length = tr.state.doc.length;
        next = {
          ...next,
          marks: effect.value.map((mark) => ({ ...mark, from: Math.min(mark.from, length), to: Math.min(Math.max(mark.to, mark.from), length) })),
        };
      } else if (effect.is(setAnnotationFocus)) next = { ...next, focus: { ...next.focus, ...effect.value } };
      else if (effect.is(setAnnotationPreview)) next = { ...next, preview: effect.value };
      else if (effect.is(setAnnotationDraft)) next = { ...next, draft: effect.value };
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => decorationsFor(value)),
});

class OrphanDot extends WidgetType {
  constructor(
    readonly id: string,
    readonly color: string,
    readonly label: string,
    readonly strong: boolean,
  ) {
    super();
  }

  eq(other: OrphanDot) {
    return other.id === this.id && other.color === this.color && other.label === this.label && other.strong === this.strong;
  }

  toDOM() {
    const dot = document.createElement("span");
    dot.className = "cm-annotation-orphan";
    dot.dataset.annotation = this.id;
    if (this.strong) dot.dataset.strong = "";
    dot.style.setProperty("--annotation-color", this.color);
    dot.setAttribute("role", "button");
    dot.setAttribute("aria-label", this.label);
    return dot;
  }

  ignoreEvent() {
    return false;
  }
}

class SuggestionPreview extends WidgetType {
  constructor(readonly insert: string) {
    super();
  }

  eq(other: SuggestionPreview) {
    return other.insert === this.insert;
  }

  toDOM() {
    const inserted = document.createElement("ins");
    inserted.className = "cm-annotation-insert";
    inserted.textContent = this.insert;
    return inserted;
  }
}

const decorationsFor = ({ marks, focus, preview, draft }: AnnotationState): DecorationSet => {
  const ranges: { from: number; to: number; decoration: Decoration }[] = [];
  for (const mark of marks) {
    const strong = focus.active === mark.id || focus.hover === mark.id;
    if (mark.orphan) {
      ranges.push({
        from: mark.from,
        to: mark.from,
        decoration: Decoration.widget({ widget: new OrphanDot(mark.id, mark.color, mark.label, strong), side: 1 }),
      });
      continue;
    }
    if (mark.to <= mark.from) continue;
    const previewing = preview?.id === mark.id;
    ranges.push({
      from: mark.from,
      to: mark.to,
      decoration: Decoration.mark({
        class: `cm-annotation${previewing ? " cm-annotation-delete" : ""}`,
        attributes: {
          "data-annotation": mark.id,
          ...(mark.resolved ? { "data-resolved": "" } : {}),
          ...(strong ? { "data-strong": "" } : {}),
          ...(focus.active === mark.id ? { "data-active": "" } : {}),
          style: `--annotation-color: ${mark.color}`,
          "aria-description": mark.label,
        },
      }),
    });
    if (previewing && preview)
      ranges.push({ from: mark.to, to: mark.to, decoration: Decoration.widget({ widget: new SuggestionPreview(preview.insert), side: 1 }) });
  }
  if (draft && draft.to > draft.from)
    ranges.push({
      from: draft.from,
      to: draft.to,
      decoration: Decoration.mark({ class: "cm-annotation-draft", attributes: { style: `--annotation-color: ${draft.color}` } }),
    });
  // A widget at a position comes after marks that start there, as CodeMirror orders them by start and side.
  ranges.sort((a, b) => a.from - b.from || a.decoration.startSide - b.decoration.startSide);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) builder.add(range.from, range.to, range.decoration);
  return builder.finish();
};

const annotationTheme = EditorView.baseTheme({
  ".cm-annotation": {
    backgroundColor: "color-mix(in srgb, var(--annotation-color) 20%, transparent)",
    borderRadius: "2px",
    cursor: "pointer",
    transition: "background-color 120ms",
  },
  ".cm-annotation[data-strong]": { backgroundColor: "color-mix(in srgb, var(--annotation-color) 42%, transparent)" },
  ".cm-annotation[data-active]": { boxShadow: "inset 0 -2px 0 var(--annotation-color)" },
  ".cm-annotation[data-resolved]": { backgroundColor: "color-mix(in srgb, #8a8478 10%, transparent)" },
  ".cm-annotation[data-resolved][data-strong]": { backgroundColor: "color-mix(in srgb, #8a8478 24%, transparent)" },
  ".cm-annotation-draft": {
    backgroundColor: "color-mix(in srgb, var(--annotation-color) 22%, transparent)",
    boxShadow: "inset 0 -2px 0 color-mix(in srgb, var(--annotation-color) 70%, transparent)",
  },
  ".cm-annotation-orphan": {
    display: "inline-block",
    width: "8px",
    height: "8px",
    margin: "0 3px",
    borderRadius: "50%",
    verticalAlign: "0.1em",
    backgroundColor: "var(--annotation-color)",
    cursor: "pointer",
  },
  ".cm-annotation-orphan[data-strong]": { boxShadow: "0 0 0 3px color-mix(in srgb, var(--annotation-color) 30%, transparent)" },
  ".cm-annotation-delete, .cm-annotation-delete *": {
    color: "var(--k2b-danger-text, #b91c1c)",
    textDecoration: "line-through",
    textDecorationThickness: "1.5px",
  },
  ".cm-annotation-insert": {
    color: "var(--k2b-success-text, #15803d)",
    backgroundColor: "color-mix(in srgb, var(--k2b-success-text, #15803d) 14%, transparent)",
    textDecoration: "none",
    borderRadius: "3px",
    padding: "0 1px",
  },
  "@media (forced-colors: active)": {
    ".cm-annotation": { forcedColorAdjust: "none", textDecoration: "underline dotted" },
    ".cm-annotation[data-active]": { textDecoration: "underline solid" },
  },
});

export type AnnotationHandlers = {
  /** The pointer entered or left a passage or a dot; `null` when it left every one. */
  onHover: (id: string | null) => void;
  /** A click on a passage or dot, with every comment there (smallest passage last) and the one shown now. */
  onActivate: (ids: string[]) => void;
};

const idsFromTarget = (view: EditorView, target: EventTarget | null): string[] => {
  if (!(target instanceof Element)) return [];
  const dot = target.closest<HTMLElement>(".cm-annotation-orphan");
  if (dot?.dataset.annotation) return [dot.dataset.annotation];
  const passage = target.closest(".cm-annotation");
  if (!passage) return [];
  const pos = view.posAtDOM(target);
  return annotationsAt(view.state, pos);
};

/** The extension the note editor adds; set comments and focus through the effects above. */
export const annotationsExtension = (handlers: AnnotationHandlers): Extension => [
  annotationField,
  annotationTheme,
  EditorView.domEventHandlers({
    mouseover(event, view) {
      const ids = idsFromTarget(view, event.target);
      handlers.onHover(ids.at(-1) ?? null);
      return false;
    },
    mouseleave() {
      handlers.onHover(null);
      return false;
    },
    click(event, view) {
      // A click that ends a selection selects; only a plain click opens the comment.
      if (!view.state.selection.main.empty) return false;
      const ids = idsFromTarget(view, event.target);
      if (ids.length) handlers.onActivate(ids);
      return false;
    },
  }),
];

/** The comments as the editor currently places them. */
export const annotationMarks = (state: EditorState): readonly AnnotationMark[] => state.field(annotationField, false)?.marks ?? [];

/** The comment ids at a document position, innermost last, for clicks that cycle through overlapping passages. */
export const annotationsAt = (state: EditorState, pos: number): string[] =>
  annotationMarks(state)
    .filter((mark) => !mark.orphan && mark.from <= pos && pos <= mark.to)
    .sort((a, b) => b.to - b.from - (a.to - a.from))
    .map((mark) => mark.id);
