import { type ChangeSet, EditorSelection, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { announce, Button, personColor, SelectionToolbar, Toolbar, useLocale } from "@k2b/ui";
import { type Accessor, batch, createEffect, createMemo, createSignal, type JSX, on, onCleanup, untrack } from "solid-js";
import type { AnnotationProjection } from "../../../../lib/annotation-contracts";
import {
  type AnnotationMark,
  createAnnotations,
  setAnnotationDraft,
  setAnnotationFlash,
  setAnnotationFocus,
  setAnnotationPreview,
  setAnnotations,
} from "../../../lib/editor/annotations";
import { asUndoStep } from "../../../lib/yjs/history";
import { changesBetween } from "../../../lib/yjs/lazy-collab";
import { insertLink, toggleInlineMark } from "../editor/editor-actions";
import { CommentMargin } from "./CommentMargin";
import { createCommentsStore } from "./comments-store";
import { createCommentsUi, isOpen } from "./comments-ui";
import { commentMessages } from "./messages";

/** How long the text an accepted suggestion wrote stays green. */
const FLASH_MS = 1_600;
/** A word for ⌘⌥M without a selection: letters, digits and joiners around the caret. */
const WORD = /[\p{L}\p{N}_'’-]/u;

const wordAt = (text: string, pos: number) => {
  let from = pos;
  let to = pos;
  while (from > 0 && WORD.test(text[from - 1]!)) from--;
  while (to < text.length && WORD.test(text[to]!)) to++;
  return to > from ? { from, to } : null;
};

/**
 * Inline comments for one note editor: the passages in the text, the selection toolbar with Comment, ⌘⌥M, and the
 * margin with its cards. The editor gives its view and calls `extension` once.
 */
export const createEditorComments = (options: {
  notebookId: string;
  noteId: string;
  me: { id: string; name: string };
  canWrite: boolean;
  /** Whether the editor itself may change the text: formatting needs it, commenting does not. */
  editable: Accessor<boolean>;
  initial: AnnotationProjection | null | undefined;
  view: Accessor<EditorView | undefined>;
}) => {
  const locale = useLocale();
  const t = () => commentMessages.resolve([locale()]).t;
  const store = createCommentsStore({
    notebookId: options.notebookId,
    noteId: options.noteId,
    initial: options.initial,
    enabled: () => true,
    failedMessage: () => t().actionFailed,
  });
  const [tick, setTick] = createSignal(0);
  const [marks, setMarks] = createSignal<readonly AnnotationMark[]>([]);
  const [selection, setSelection] = createSignal<{ from: number; to: number } | null>(null);
  const flashTimers = new Set<ReturnType<typeof setTimeout>>();
  onCleanup(() => {
    for (const timer of flashTimers) clearTimeout(timer);
  });

  const ui = createCommentsUi({
    store,
    canWrite: () => options.canWrite,
    me: options.me,
    t,
    text: () => options.view()?.state.doc.toString() ?? "",
    linkTo: (id) => {
      const url = new URL(window.location.href);
      url.searchParams.set("annotation", id);
      url.hash = "";
      return url.toString();
    },
    flash: (id, length) => {
      const view = options.view();
      const mark = view && annotations.marks(view.state).find((entry) => entry.id === id);
      if (!view || !mark || !length) return;
      view.dispatch({ effects: setAnnotationFlash.of({ from: mark.from, length }) });
      const timer = setTimeout(() => {
        flashTimers.delete(timer);
        options.view()?.dispatch({ effects: setAnnotationFlash.of(null) });
      }, FLASH_MS);
      flashTimers.add(timer);
    },
  });

  const annotations = createAnnotations({
    initial: () => untrack(placed),
    onHover: (id) => ui.setHover(id),
    onActivate: (ids) => ui.activateFrom(ids),
  });

  /**
   * The server places comments in the text it read; the editor may be ahead of it by edits on their way. The places
   * move with those edits, as CodeMirror would have moved them.
   */
  const placed = createMemo(
    () => {
      const projection = store.projection();
      const view = options.view();
      if (!projection || !view) return [] as AnnotationMark[];
      void tick();
      const current = view.state.doc.toString();
      const changes: ChangeSet | null = projection.text === current ? null : changesBetween(projection.text, current);
      const map = (pos: number, assoc: 1 | -1) =>
        changes ? changes.mapPos(Math.min(pos, changes.length), assoc) : Math.min(pos, current.length);
      return ui.visible().map((item): AnnotationMark => {
        const from = map(item.from, 1);
        const to = item.orphan ? from : Math.max(from, map(item.to, -1));
        const name = item.author.kind === "user" && item.author.id === options.me.id ? t().you : item.author.name;
        return {
          id: item.id,
          from,
          to,
          color: personColor(item.author.name),
          resolved: !isOpen(item),
          orphan: item.orphan || to <= from,
          label: item.orphan || to <= from ? t().deletedPassage({ name }) : t().commentedBy({ names: name }),
        };
      });
    },
    [],
    { equals: false },
  );

  // A new projection replaces the places; edits in between move them inside the editor.
  createEffect(
    on([() => store.projection(), ui.visible, options.view], () => {
      const view = options.view();
      if (!view) return;
      view.dispatch({ effects: setAnnotations.of(placed()) });
      setMarks(annotations.marks(view.state));
    }),
  );
  createEffect(() => {
    options.view()?.dispatch({ effects: setAnnotationFocus.of({ hover: ui.hover(), active: ui.active() }) });
  });
  createEffect(() => {
    const id = ui.preview();
    const item = ui.byId(id);
    options
      .view()
      ?.dispatch({ effects: setAnnotationPreview.of(item && item.suggestion !== null ? { id: item.id, insert: item.suggestion } : null) });
  });
  createEffect(() => {
    const draft = ui.draft();
    options.view()?.dispatch({ effects: setAnnotationDraft.of(draft ? { from: draft.from, to: draft.to, color: ui.myColor } : null) });
  });

  const startFromSelection = (view: EditorView) => {
    const range = view.state.selection.main;
    const text = view.state.doc.toString();
    const target = range.empty ? wordAt(text, range.head) : { from: range.from, to: range.to };
    if (!target || !ui.startDraft(target.from, target.to)) return false;
    // The passage is marked as the draft now; the selection would hide it.
    view.dispatch({ selection: EditorSelection.cursor(target.to) });
    setSelection(null);
    return true;
  };

  // The caret entering a commented passage says whose comment it is and how to open it, once per passage.
  let announced: string | null = null;
  const announcePassage = (view: EditorView) => {
    if (!view.hasFocus) return;
    const head = view.state.selection.main.head;
    const marks = annotations.marks(view.state).filter((mark) => !mark.orphan && mark.from <= head && head <= mark.to);
    const key = marks.map((mark) => mark.id).join(" ") || null;
    if (key === announced) return;
    announced = key;
    if (marks.length) announce(`${marks.map((mark) => mark.label).join(", ")}. ${t().openHint}`);
  };

  /** The toolbar opens once the pointer is released over a selection, not while it is dragged. */
  let pointerDown = false;
  const syncSelection = (view: EditorView) => {
    const range = view.state.selection.main;
    setSelection(range.empty || pointerDown || !view.hasFocus ? null : { from: range.from, to: range.to });
  };

  const extension = [
    annotations.extension,
    Prec.high(keymap.of([{ key: "Mod-Alt-m", run: (view) => startFromSelection(view) }])),
    EditorView.updateListener.of((update) => {
      if (update.docChanged || update.geometryChanged || update.viewportChanged) {
        setTick((value) => value + 1);
        setMarks(annotations.marks(update.state));
      }
      if (update.selectionSet || update.focusChanged) {
        syncSelection(update.view);
        announcePassage(update.view);
      }
    }),
    EditorView.domEventHandlers({
      pointerdown: () => {
        pointerDown = true;
        setSelection(null);
        return false;
      },
      pointerup: (_event, view) => {
        pointerDown = false;
        queueMicrotask(() => syncSelection(view));
        return false;
      },
      keydown: (event) => {
        // ⌥⏎ goes from a passage to its comment.
        if (event.key !== "Enter" || !event.altKey) return false;
        const view = options.view();
        const pos = view?.state.selection.main.head;
        const mark = pos === undefined ? undefined : annotations.marks(view!.state).find((entry) => entry.from <= pos && pos <= entry.to);
        if (!mark) return false;
        event.preventDefault();
        ui.setActive(mark.id);
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-annotation-card="${mark.id}"]`)?.focus());
        return true;
      },
    }),
  ];

  const selectionBox = () => {
    const view = options.view();
    const range = selection();
    if (!view || !range || !options.canWrite) return null;
    const start = view.coordsAtPos(range.from, 1);
    const end = view.coordsAtPos(range.to, -1);
    if (!start || !end) return null;
    // The first line of the selection: the toolbar centers over it.
    const sameLine = Math.abs(start.top - end.top) < 4;
    const left = start.left;
    const right = sameLine ? end.right : view.contentDOM.getBoundingClientRect().right;
    return new DOMRect(left, start.top, Math.max(1, right - left), (sameLine ? end.bottom : start.bottom) - start.top);
  };
  const phone = () => window.matchMedia("(pointer: coarse)").matches;
  const run = (command: (view: EditorView) => void) => {
    const view = options.view();
    if (!view) return;
    void asUndoStep(view, () => command(view));
    view.focus();
  };

  const toolbar = (scroller: Accessor<HTMLElement | undefined>): JSX.Element => (
    <SelectionToolbar
      label={t().selection}
      anchor={selectionBox}
      placement={phone() ? "below" : "above"}
      boundary={scroller}
      onEscape={() => {
        setSelection(null);
        options.view()?.focus();
      }}
    >
      {options.editable() && (
        <>
          <Toolbar.Action label={t().bold} icon="ti ti-bold" keys="mod+b" onClick={() => run((view) => toggleInlineMark(view, "bold"))} />
          <Toolbar.Action
            label={t().italic}
            icon="ti ti-italic"
            keys="mod+i"
            onClick={() => run((view) => toggleInlineMark(view, "italic"))}
          />
          <Toolbar.Action label={t().link} icon="ti ti-link" keys="mod+k" onClick={() => run((view) => insertLink(view, locale()))} />
          <Toolbar.Separator />
        </>
      )}
      <Button
        size="sm"
        variant="ghost"
        title={`${t().comment} ⌘⌥M`}
        onClick={() => {
          const view = options.view();
          if (view) batch(() => startFromSelection(view));
        }}
      >
        <i class="ti ti-message-plus" aria-hidden="true" />
        {t().comment}
      </Button>
    </SelectionToolbar>
  );

  const margin = (
    host: Accessor<HTMLElement | undefined>,
    surface: Accessor<HTMLElement | undefined>,
    onExtent: (bottom: number) => void,
  ) => (
    <CommentMargin
      ui={ui}
      view={options.view}
      host={host}
      surface={surface}
      marks={marks}
      tick={tick}
      onExtent={onExtent}
      onReturn={(id) => {
        const view = options.view();
        const mark = view && annotations.marks(view.state).find((entry) => entry.id === id);
        if (!view || !mark) return;
        view.dispatch({ selection: EditorSelection.cursor(mark.from), scrollIntoView: true });
        view.focus();
      }}
    />
  );

  // A link to a comment (?annotation=<id>, or "first") opens it once the comments are there.
  const requested = new URLSearchParams(window.location.search).get("annotation");
  if (requested) {
    createEffect(
      on(
        () => store.projection(),
        (projection, _previous, done) => {
          if (done || !projection) return done;
          // "first" comes from Book's comments entry: the first open comment in the text.
          const item =
            requested === "first"
              ? [...projection.items].filter(isOpen).sort((a, b) => a.from - b.from)[0]
              : projection.items.find((entry) => entry.id === requested);
          if (requested === "first" && !item) return true;
          if (!item) return false;
          if (!isOpen(item)) ui.setShowResolved(true);
          ui.setActive(item.id);
          requestAnimationFrame(() => {
            const view = options.view();
            const mark = view && annotations.marks(view.state).find((entry) => entry.id === item.id);
            if (view && mark) view.dispatch({ effects: EditorView.scrollIntoView(mark.from, { y: "center" }) });
          });
          return true;
        },
      ),
    );
  }

  return { ui, store, extension, toolbar, margin, openCount: () => ui.counts().open };
};
