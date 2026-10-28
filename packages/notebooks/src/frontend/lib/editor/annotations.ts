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
/** Text just written by an accepted suggestion, green for a moment: it starts where the passage started. */
export type AnnotationFlash = { from: number; length: number } | null;

type AnnotationState = {
  marks: AnnotationMark[];
  focus: AnnotationFocus;
  preview: AnnotationPreview;
  draft: AnnotationDraft;
  flash: AnnotationFlash;
};

export const setAnnotations = StateEffect.define<AnnotationMark[]>();
export const setAnnotationFocus = StateEffect.define<Partial<AnnotationFocus>>();
export const setAnnotationPreview = StateEffect.define<AnnotationPreview>();
export const setAnnotationDraft = StateEffect.define<AnnotationDraft>();
export const setAnnotationFlash = StateEffect.define<AnnotationFlash>();

/** A start sticks to the first character and an end to the last, so typing at the edges does not widen a passage. */
const mapMark = (mark: AnnotationMark, changes: ChangeSet): AnnotationMark => {
  const from = changes.mapPos(mark.from, 1);
  const to = changes.mapPos(mark.to, -1);
  if (mark.orphan || to > from) return { ...mark, from, to: Math.max(from, to) };
  // Everything the passage held was deleted: the comment keeps a dot where it stood.
  const at = changes.mapPos(mark.from, -1);
  return { ...mark, from: at, to: at, orphan: true };
};

class OrphanDot extends WidgetType {
  constructor(
    readonly id: string,
    readonly color: string,
    readonly label: string,
    readonly strong: boolean,
  ) {
    super();
  }

  override eq(other: OrphanDot) {
    return other.id === this.id && other.color === this.color && other.label === this.label && other.strong === this.strong;
  }

  override toDOM() {
    const dot = document.createElement("span");
    dot.className = "cm-annotation-orphan";
    dot.dataset.annotation = this.id;
    if (this.strong) dot.dataset.strong = "";
    dot.style.setProperty("--annotation-color", this.color);
    dot.setAttribute("role", "button");
    dot.setAttribute("aria-label", this.label);
    return dot;
  }

  override ignoreEvent() {
    return false;
  }
}

class SuggestionPreview extends WidgetType {
  constructor(readonly insert: string) {
    super();
  }

  override eq(other: SuggestionPreview) {
    return other.insert === this.insert;
  }

  override toDOM() {
    const inserted = document.createElement("ins");
    inserted.className = "cm-annotation-insert";
    inserted.textContent = this.insert;
    return inserted;
  }
}

const decorationsFor = ({ marks, focus, preview, draft, flash }: AnnotationState, length: number): DecorationSet => {
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
      ranges.push({
        from: mark.to,
        to: mark.to,
        decoration: Decoration.widget({ widget: new SuggestionPreview(preview.insert), side: 1 }),
      });
  }
  if (draft && draft.to > draft.from)
    ranges.push({
      from: draft.from,
      to: draft.to,
      decoration: Decoration.mark({ class: "cm-annotation-draft", attributes: { style: `--annotation-color: ${draft.color}` } }),
    });
  if (flash && flash.length > 0 && flash.from < length)
    ranges.push({
      from: flash.from,
      to: Math.min(length, flash.from + flash.length),
      decoration: Decoration.mark({ class: "cm-annotation-flash" }),
    });
  // A widget at a position comes after marks that start there, as CodeMirror orders them by start and side.
  ranges.sort((a, b) => a.from - b.from || a.decoration.startSide - b.decoration.startSide);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) builder.add(range.from, range.to, range.decoration);
  return builder.finish();
};

const clampMarks = (marks: readonly AnnotationMark[], length: number) =>
  marks.map((mark) => ({ ...mark, from: Math.min(mark.from, length), to: Math.min(Math.max(mark.to, mark.from), length) }));

/**
 * The field is created when the editor adds the extension, which can be after the comments arrived: it starts from
 * `initial` then.
 */
const createAnnotationField = (initial: () => readonly AnnotationMark[]) =>
  StateField.define<AnnotationState>({
    create: (state) => ({
      marks: clampMarks(initial(), state.doc.length),
      focus: { hover: null, active: null },
      preview: null,
      draft: null,
      flash: null,
    }),
    update(value, tr) {
      let next = value;
      if (tr.docChanged) {
        const draft = next.draft && {
          ...next.draft,
          from: tr.changes.mapPos(next.draft.from, 1),
          to: tr.changes.mapPos(next.draft.to, -1),
        };
        // The replacement arrives after the flash is set; its start stays before the inserted text.
        const flash = next.flash && { ...next.flash, from: tr.changes.mapPos(next.flash.from, -1) };
        next = {
          ...next,
          marks: next.marks.map((mark) => mapMark(mark, tr.changes)),
          draft: draft && draft.to > draft.from ? draft : null,
          flash,
        };
      }
      for (const effect of tr.effects) {
        if (effect.is(setAnnotations)) {
          next = { ...next, marks: clampMarks(effect.value, tr.state.doc.length) };
        } else if (effect.is(setAnnotationFocus)) next = { ...next, focus: { ...next.focus, ...effect.value } };
        else if (effect.is(setAnnotationPreview)) next = { ...next, preview: effect.value };
        else if (effect.is(setAnnotationDraft)) next = { ...next, draft: effect.value };
        else if (effect.is(setAnnotationFlash)) next = { ...next, flash: effect.value };
      }
      return next;
    },
    provide: (field) => EditorView.decorations.compute([field], (state) => decorationsFor(state.field(field), state.doc.length)),
  });

export type AnnotationHandlers = {
  /** The comments the editor starts with when it adds the extension. */
  initial: () => readonly AnnotationMark[];
  /** The pointer entered or left a passage or a dot; `null` when it left every one. */
  onHover: (id: string | null) => void;
  /** A click on a passage or dot, with every comment there (smallest passage last). */
  onActivate: (ids: string[]) => void;
};

/** The comment ids at a position, smallest passage last, for clicks that cycle through overlapping passages. */
const idsAt = (marks: readonly AnnotationMark[], pos: number): string[] =>
  marks
    .filter((mark) => !mark.orphan && mark.from <= pos && pos <= mark.to)
    .sort((a, b) => b.to - b.from - (a.to - a.from))
    .map((mark) => mark.id);

/**
 * One note editor's comments: the extension it adds, and where the comments stand in a state of that editor. Set
 * comments and focus through the effects above.
 */
export const createAnnotations = (handlers: AnnotationHandlers) => {
  const field = createAnnotationField(handlers.initial);
  const marks = (state: EditorState): readonly AnnotationMark[] => state.field(field, false)?.marks ?? [];
  const idsFromTarget = (view: EditorView, target: EventTarget | null): string[] => {
    if (!(target instanceof Element)) return [];
    const dot = target.closest<HTMLElement>(".cm-annotation-orphan");
    if (dot?.dataset.annotation) return [dot.dataset.annotation];
    if (!target.closest(".cm-annotation")) return [];
    return idsAt(marks(view.state), view.posAtDOM(target));
  };
  // The look of passages, dots and previews is in the app's stylesheet, shared with the server preview.
  const extension: Extension = [
    field,
    EditorView.domEventHandlers({
      mouseover(event, view) {
        handlers.onHover(idsFromTarget(view, event.target).at(-1) ?? null);
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
  return { extension, marks, idsAt: (state: EditorState, pos: number) => idsAt(marks(state), pos) };
};
