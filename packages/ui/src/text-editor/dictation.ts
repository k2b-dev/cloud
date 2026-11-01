import { isolateHistory } from "@codemirror/commands";
import { type Range, type RangeSet, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { DictationTarget } from "../inputs/dictation/types";

type DictationState = {
  /** Where the next words land; `null` while no dictation is open. */
  mark: number | null;
  /** Every range dictation inserted, mapped through all later edits. */
  dictated: RangeSet<Decoration>;
  /** The newest words, tinted for a moment. */
  fresh: DecorationSet;
};

const dictatedMark = Decoration.mark({ class: "k2b-dictation-dictated" });
const freshMark = (at: number) => Decoration.mark({ class: "k2b-dictation-fresh", at });

class MarkWidget extends WidgetType {
  override eq() {
    return true;
  }
  override toDOM() {
    const mark = document.createElement("span");
    mark.className = "k2b-dictation-mark";
    mark.setAttribute("aria-hidden", "true");
    return mark;
  }
  override ignoreEvent() {
    return true;
  }
}

const open = StateEffect.define<number>();
const inserted = StateEffect.define<{ from: number; to: number; mark: number }>();
/** Removes the tint of words older than the given time. */
const settle = StateEffect.define<number>();
const close = StateEffect.define<null>();

const empty: DictationState = { mark: null, dictated: Decoration.none, fresh: Decoration.none };

const dictationField = StateField.define<DictationState>({
  create: () => empty,
  update(value, tr) {
    let next: DictationState = tr.docChanged
      ? {
          // Edits elsewhere move the mark along; text typed exactly at the mark stays before the next words.
          mark: value.mark === null ? null : tr.changes.mapPos(value.mark, 1),
          dictated: value.dictated.map(tr.changes),
          fresh: value.fresh.map(tr.changes),
        }
      : value;
    for (const effect of tr.effects) {
      if (effect.is(open)) next = { ...next, mark: effect.value };
      else if (effect.is(inserted)) {
        const { from, to, mark } = effect.value;
        next = {
          mark,
          dictated: next.dictated.update({ add: [dictatedMark.range(from, to)] }),
          fresh: next.fresh.update({ add: [freshMark(Date.now()).range(from, to)] }),
        };
      } else if (effect.is(settle)) {
        const before = effect.value;
        next = { ...next, fresh: next.fresh.update({ filter: (_from, _to, value) => (value.spec.at as number) > before }) };
      } else if (effect.is(close)) next = empty;
    }
    return next;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (state) => state.fresh),
    EditorView.decorations.from(field, (state) =>
      state.mark === null ? Decoration.none : Decoration.set([Decoration.widget({ widget: new MarkWidget(), side: 1 }).range(state.mark)]),
    ),
  ],
});

const space = /\s/;
const freshMs = 1_500;

/** The editor state dictation needs; add it to the view that `codeMirrorDictationTarget` writes into. */
export const dictationExtension = () => dictationField;

/**
 * A dictation target for a CodeMirror view. Words go into the document at once, as typed text does, so a shared
 * document shows them to everyone and they last as long as the host saves typed text. The mark follows local and
 * remote edits; Discard removes exactly the dictated ranges in one step, including what the person typed inside them.
 */
export function codeMirrorDictationTarget(editorView: () => EditorView | undefined): DictationTarget {
  /** The first words of each session get one space from earlier text, never two. */
  let sessionStart = false;
  const view = () => {
    const current = editorView();
    return current?.state.field(dictationField, false) ? current : undefined;
  };
  return {
    begin: () => {
      const current = view();
      if (!current) return;
      sessionStart = true;
      // A new session of the same dictation writes on at its mark.
      if (current.state.field(dictationField).mark !== null) return;
      current.dispatch({ effects: open.of(current.state.selection.main.head), annotations: isolateHistory.of("before") });
    },
    insert: (text) => {
      const current = view();
      const mark = current?.state.field(dictationField).mark;
      // A view that turned read-only takes no more words; the host ends the dictation.
      if (!current || mark === null || mark === undefined || current.state.readOnly) return;
      let chunk = text;
      if (sessionStart) {
        const before = current.state.doc.sliceString(Math.max(0, mark - 1), mark);
        if (!before || space.test(before)) chunk = chunk.replace(/^[^\S\n]+/, "");
        else if (chunk && !space.test(chunk[0]!)) chunk = ` ${chunk}`;
      }
      if (!chunk) return;
      // The first words right before existing text keep one space to it; the mark stays before that space.
      const after = current.state.doc.sliceString(mark, mark + 1);
      const gap = sessionStart && after && !space.test(after) && !space.test(chunk[chunk.length - 1]!) ? " " : "";
      sessionStart = false;
      current.dispatch({
        changes: { from: mark, insert: chunk + gap },
        effects: inserted.of({ from: mark, to: mark + chunk.length + gap.length, mark: mark + chunk.length }),
        annotations: [Transaction.userEvent.of("input.dictate"), Transaction.addToHistory.of(true)],
      });
      // Each chunk keeps its tint for the same time, also while speech goes on.
      const at = Date.now();
      setTimeout(() => view()?.dispatch({ effects: settle.of(at) }), freshMs);
    },
    discard: () => {
      const current = view();
      if (!current) return;
      const ranges: Range<Decoration>[] = [];
      const cursor = current.state.field(dictationField).dictated.iter();
      for (; cursor.value; cursor.next()) ranges.push(cursor.value.range(cursor.from, cursor.to));
      current.dispatch({
        changes: ranges.filter((range) => range.to > range.from).map((range) => ({ from: range.from, to: range.to })),
        effects: close.of(null),
        annotations: [Transaction.userEvent.of("delete.dictate"), isolateHistory.of("full")],
      });
    },
    end: () => {
      view()?.dispatch({ effects: close.of(null), annotations: isolateHistory.of("after") });
    },
  };
}
