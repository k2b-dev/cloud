import type { EditorView } from "@codemirror/view";
import { personColor, useLocale } from "@k2b/ui";
import { type Accessor, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { Annotation } from "../../../../lib/annotation-contracts";
import type { AnnotationMark } from "../../../lib/editor/annotations";
import { CommentCard } from "./CommentCard";
import { CommentComposer } from "./CommentComposer";
import { openCommentSheet } from "./CommentSheet";
import type { CommentsUi } from "./comments-ui";
import { type CommentsLayout, commentsLayout, groupDots, stackCards } from "./margin-layout";

/** The margin: 40 px beside the column, 288 px wide, its head the fixed place for counts, loading and errors. */
const GAP = 40;
const HEAD_TOP = 16;
const HEAD_HEIGHT = 44;
const MIN_TOP = HEAD_TOP + HEAD_HEIGHT + 8;
/** A card stands a little above its passage's first line, where the eye starts reading it. */
const LIFT = 10;
const POPOVER_WIDTH = 340;

type Props = {
  ui: CommentsUi;
  view: Accessor<EditorView | undefined>;
  /** The positioned element around the editor that cards are placed in. */
  host: Accessor<HTMLElement | undefined>;
  /** The note's surface, whose width alone decides the layout. */
  surface: Accessor<HTMLElement | undefined>;
  /** Where the editor places each comment now. */
  marks: Accessor<readonly AnnotationMark[]>;
  /** Changes whenever the editor's geometry may have changed. */
  tick: Accessor<number>;
  /** Asks for the host to grow so the last card stays reachable. */
  onExtent: (bottom: number) => void;
  /** Puts the caret back on a comment's passage. */
  onReturn: (id: string) => void;
};

/** Ignore clicks on these when deciding whether a click went "elsewhere" and closes the open comment. */
const INSIDE =
  ".notebook-comment, .notebook-comments-dot, .cm-annotation, .cm-annotation-orphan, .k2b-dropdown__menu, .k2b-toast, dialog, .k2b-selection-toolbar";

export function CommentMargin(props: Props) {
  const ui = props.ui;
  const locale = useLocale();
  const t = () => ui.t();
  const [layout, setLayout] = createSignal<CommentsLayout>("compact");
  const [column, setColumn] = createSignal<{ left: number; right: number } | null>(null);
  const [tops, setTops] = createSignal<ReadonlyMap<string, number>>(new Map());
  const [placed, setPlaced] = createSignal<ReadonlyMap<string, number>>(new Map());
  const cards = new Map<string, HTMLElement>();

  onMount(() => {
    const surface = props.surface();
    if (!surface) return;
    const read = () => setLayout(commentsLayout(props.host()));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(surface);
    onCleanup(() => observer.disconnect());
  });

  const markOf = (id: string) => props.marks().find((mark) => mark.id === id);
  /** The top of a document position in the host, measured where drawn and estimated from the height map elsewhere. */
  const topOf = (view: EditorView, host: HTMLElement, pos: number) => {
    const at = Math.min(pos, view.state.doc.length);
    const drawn = view.coordsAtPos(at, 1);
    const top = drawn ? drawn.top : view.documentTop + view.lineBlockAt(at).top;
    return top - host.getBoundingClientRect().top;
  };
  const bottomOf = (view: EditorView, host: HTMLElement, pos: number) => {
    const at = Math.min(pos, view.state.doc.length);
    const drawn = view.coordsAtPos(at, -1);
    const bottom = drawn ? drawn.bottom : view.documentTop + view.lineBlockAt(at).bottom;
    return bottom - host.getBoundingClientRect().top;
  };

  /** Measures passages, then the cards, then places them: one read pass, one write pass. */
  let frame = 0;
  const measure = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const view = props.view();
      const host = props.host();
      if (!view || !host) return;
      // The detail panel and full width change the layout without resizing anything observed.
      setLayout(commentsLayout(host));
      const hostBox = host.getBoundingClientRect();
      const content = view.contentDOM.getBoundingClientRect();
      setColumn({ left: content.left - hostBox.left, right: content.right - hostBox.left });
      const wants = new Map<string, number>();
      for (const item of ui.visible()) {
        const mark = markOf(item.id);
        if (mark) wants.set(item.id, topOf(view, host, mark.from));
      }
      const draft = ui.draft();
      if (draft) wants.set("__draft", topOf(view, host, draft.from));
      setTops(wants);
      if (layout() !== "wide" && layout() !== "shift") return;
      const order = [...wants.keys()].sort((a, b) => wants.get(a)! - wants.get(b)!);
      const focus = draft ? "__draft" : ui.active();
      const stacked = stackCards(
        order.map((id) => ({ want: wants.get(id)! - LIFT, height: cards.get(id)?.offsetHeight ?? 0 })),
        focus ? order.indexOf(focus) : -1,
        MIN_TOP,
      );
      setPlaced(new Map(order.map((id, index) => [id, stacked[index]!])));
      const bottom = Math.max(0, ...order.map((id, index) => stacked[index]! + (cards.get(id)?.offsetHeight ?? 0)));
      props.onExtent(bottom + 120);
    });
  };
  onCleanup(() => cancelAnimationFrame(frame));
  createEffect(on([props.tick, ui.visible, ui.active, ui.draft, ui.editing, layout, props.marks, () => ui.store.items()], () => measure()));
  onMount(() => {
    const observer = new ResizeObserver(() => measure());
    const watch = () => {
      observer.disconnect();
      for (const card of cards.values()) observer.observe(card);
    };
    createEffect(on([ui.visible, ui.draft, ui.active], () => queueMicrotask(watch)));
    onCleanup(() => observer.disconnect());
  });

  // A click elsewhere closes the open comment, as Escape does.
  onMount(() => {
    const onClick = (event: MouseEvent) => {
      if (!ui.active()) return;
      if (event.target instanceof Element && event.target.closest(INSIDE)) return;
      ui.setActive(null);
    };
    document.addEventListener("click", onClick);
    onCleanup(() => document.removeEventListener("click", onClick));
  });

  // On a phone, comments open in a sheet: the one written, the one tapped, or the list from the toolbar.
  const [list, setList] = createSignal(false);
  const [sheetOpen, setSheetOpen] = createSignal(false);
  createEffect(() => {
    if (layout() !== "phone" || sheetOpen() || !(ui.draft() || ui.active() || list())) return;
    setSheetOpen(true);
    void openCommentSheet(ui, locale(), list, () => {
      setSheetOpen(false);
      setList(false);
    });
  });
  // The toolbar's comments button: the list on a phone, the first comment in a popover, or the margin's first card.
  createEffect(
    on(
      ui.listRequest,
      () => {
        const first = ui.visible()[0];
        if (layout() === "phone") setList(true);
        else if (layout() === "compact") ui.setActive(first?.id ?? null);
        else if (first) cards.get(first.id)?.focus();
      },
      { defer: true },
    ),
  );

  const register = (id: string) => (element: HTMLElement) => {
    cards.set(id, element);
    onCleanup(() => {
      if (cards.get(id) === element) cards.delete(id);
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const articles = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-annotation-card]")];
    const current = articles.findIndex((article) => article.contains(document.activeElement));
    if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      event.target instanceof HTMLElement &&
      event.target.matches("[data-annotation-card]")
    ) {
      event.preventDefault();
      const next = articles[current + (event.key === "ArrowDown" ? 1 : -1)];
      next?.focus();
    }
    if (event.key === "Escape") {
      const id = ui.active() ?? articles[current]?.dataset.annotationCard;
      if (!id) return;
      event.preventDefault();
      ui.setActive(null);
      props.onReturn(id);
    }
  };

  const failed = () => (
    <>
      <span class="notebook-comments__error">{t().loadFailed}</span>
      <button type="button" class="notebook-comments__retry" onClick={() => void ui.store.refresh()}>
        {t().retry}
      </button>
    </>
  );
  const head = () => (
    <div class="notebook-comments__head" aria-live="polite">
      <Show when={!ui.store.error()} fallback={failed()}>
        <Show when={ui.store.projection()} fallback={<span>{t().loading}</span>}>
          <Show
            when={ui.counts().open || ui.counts().resolved}
            fallback={
              <>
                <span>{t().empty}</span>
                <Show when={ui.canWrite()}>
                  <span class="notebook-comments__hint">{t().emptyHint}</span>
                </Show>
              </>
            }
          >
            <span>
              <b>{ui.counts().open}</b> {t().openWord}
            </span>
            <Show when={ui.counts().resolved}>
              <button type="button" class="notebook-comments__toggle" onClick={() => ui.setShowResolved(!ui.showResolved())}>
                {ui.showResolved() ? t().hideResolved : t().resolvedCount({ count: ui.counts().resolved })}
              </button>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  );

  const dots = createMemo(() => {
    const at = tops();
    return groupDots(
      ui
        .visible()
        .flatMap((item) => (at.has(item.id) ? [{ item, top: at.get(item.id)! }] : []))
        .map((entry) => ({ ...entry, top: entry.top })),
    );
  });
  const activeItem = createMemo<Annotation | undefined>(() => ui.byId(ui.active()));
  const color = (item: Annotation) => (item.state === "open" ? personColor(item.author.name) : "#8a8478");

  return (
    <>
      <Show when={(layout() === "wide" || layout() === "shift") && column()}>
        {(col) => (
          <aside class="notebook-comments" aria-label={t().comments} style={{ left: `${col().right + GAP}px` }} onKeyDown={onKeyDown}>
            {head()}
            <Show when={ui.store.projection()}>
              <For each={ui.visible()}>
                {(item) => (
                  <CommentCard
                    ui={ui}
                    item={item}
                    ref={register(item.id)}
                    style={{ top: `${placed().get(item.id) ?? (tops().get(item.id) ?? MIN_TOP) - LIFT}px` }}
                  />
                )}
              </For>
              <Show when={ui.draft()}>
                <CommentComposer
                  ui={ui}
                  ref={register("__draft")}
                  style={{ top: `${placed().get("__draft") ?? (tops().get("__draft") ?? MIN_TOP) - LIFT}px` }}
                />
              </Show>
            </Show>
          </aside>
        )}
      </Show>
      <Show when={layout() === "compact" && column()}>
        {(col) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: the dots and the popover inside take the keys; Escape returns to the passage.
          <div class="notebook-comments-gutter" onKeyDown={onKeyDown}>
            <For each={dots()}>
              {(group) => (
                <button
                  type="button"
                  class="notebook-comments-dot"
                  data-active={group.some((entry) => entry.item.id === ui.active()) ? "" : undefined}
                  style={{ top: `${group[0]!.top + 2}px`, left: `${col().right + 10}px` }}
                  aria-label={t().dots({ count: group.length })}
                  onClick={() => ui.activateFrom(group.map((entry) => entry.item.id))}
                >
                  <For each={group}>{(entry) => <span style={{ background: color(entry.item) }} />}</For>
                  <Show when={group.length > 1}>{group.length}</Show>
                </button>
              )}
            </For>
            <Show when={ui.store.error()}>
              <div class="notebook-comments-popover" style={{ top: `${MIN_TOP}px`, left: `${Math.max(0, col().right - POPOVER_WIDTH)}px` }}>
                <div class="notebook-comment" data-active="" role="alert">
                  {failed()}
                </div>
              </div>
            </Show>
            <Show when={!ui.draft() && activeItem()}>
              {(item) => {
                const view = props.view();
                const host = props.host();
                const mark = markOf(item().id);
                const top = view && host && mark ? bottomOf(view, host, mark.to) + 8 : MIN_TOP;
                return (
                  <div class="notebook-comments-popover" style={{ top: `${top}px`, left: `${Math.max(0, col().right - POPOVER_WIDTH)}px` }}>
                    <CommentCard ui={ui} item={item()} />
                  </div>
                );
              }}
            </Show>
            <Show when={ui.draft()}>
              {(draft) => {
                const view = props.view();
                const host = props.host();
                const top = view && host ? bottomOf(view, host, draft().to) + 8 : MIN_TOP;
                return (
                  <div class="notebook-comments-popover" style={{ top: `${top}px`, left: `${Math.max(0, col().right - POPOVER_WIDTH)}px` }}>
                    <CommentComposer ui={ui} />
                  </div>
                );
              }}
            </Show>
          </div>
        )}
      </Show>
    </>
  );
}
