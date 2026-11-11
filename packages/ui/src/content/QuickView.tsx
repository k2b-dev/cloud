import { type Accessor, createEffect, createSignal, For, type JSX, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { IconButton } from "../actions/Button";
import { Toolbar } from "../actions/Toolbar";
import { returnFocus, ringOnReturn } from "../internal/focus-return";
import { showTruncatedTitle } from "../internal/truncated-title";
import { useQuickViewMessages } from "./quick-view-messages";
import { ThumbnailStrip } from "./ThumbnailStrip";

/** One file or object a `QuickView` can show. */
export type QuickViewItem = {
  id: string;
  /** The name in the chip at the top and in the dialog's accessible name. It never wraps. */
  name: string;
  /** Quiet facts after the name, such as "5.1 MB · 4 pages". */
  facts?: string;
  /** The tile in the film strip: a small image URL, or a component that renders the caller's own tile. */
  thumbnail?: string | (() => JSX.Element);
  /** Whether − and + zoom this item. Others keep the zoom controls in place, disabled, so the pill never moves. */
  zoomable?: boolean;
};

/** A round command at the top, before Close, such as Download or Share. */
export type QuickViewAction = { label: string; icon: string; onClick: () => void };

export type QuickViewProps = {
  items: readonly QuickViewItem[];
  /** The `id` of the shown item. The host owns it, so it can follow the selection behind the view. */
  current: string;
  onCurrentChange: (id: string) => void;
  onClose: () => void;
  /**
   * Draws the shown item on the stage, mounted once per item. `zoom` is a factor of the fitted size, 1 at first;
   * apply it to the content, such as an image's frame or a PDF viewer's `scale`.
   */
  children: (item: QuickViewItem, zoom: Accessor<number>) => JSX.Element;
  /** Round commands for the shown item at the top, before Close. */
  actions?: (item: QuickViewItem) => readonly QuickViewAction[];
};

/** Steps for − and +, as factors of the fitted size. */
const QUICK_VIEW_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const SWIPE = 60;

/** Keys inside these keep their own meaning; Space presses a button instead of closing the view. */
const interactive = (target: EventTarget | null) =>
  target instanceof Element &&
  Boolean(target.closest("button, a[href], input, textarea, select, [contenteditable=''], [contenteditable=true]"));

/**
 * A large look at one item of a sequence without leaving the page, as Space opens it on a desktop: the name at the top
 * left, the item's commands and Close at the top right, the item on a quiet blurred stage, and one floating pill at the
 * bottom with previous, position, next and zoom. A film strip below the pill shows the neighbours on wide screens.
 *
 * Space and Escape close, the arrow keys step (Up and Down only outside a scrolling document), − and + zoom, 0 fits.
 * A swipe steps on touch screens. Focus returns to the opener. The host renders the item and keeps its own loading,
 * error, and retry states on the stage, so nothing around it moves.
 */
export function QuickView(props: QuickViewProps): JSX.Element {
  const t = useQuickViewMessages();
  const [zoom, setZoom] = createSignal(1);
  let dialog!: HTMLDialogElement;
  let opener: HTMLElement | null = null;
  let openerRing = true;

  const index = () =>
    Math.max(
      0,
      props.items.findIndex((item) => item.id === props.current),
    );
  const item = () => props.items[index()];
  const zoomable = () => item()?.zoomable === true;
  createEffect(
    on(
      () => props.current,
      () => setZoom(1),
      { defer: true },
    ),
  );

  const step = (direction: 1 | -1) => {
    const count = props.items.length;
    if (count < 2) return;
    const next = props.items[(index() + direction + count) % count];
    if (next) props.onCurrentChange(next.id);
  };
  const zoomBy = (direction: 1 | -1) => {
    if (!zoomable()) return;
    const value = zoom();
    const next =
      direction > 0
        ? QUICK_VIEW_ZOOM_STEPS.find((candidate) => candidate > value + 0.001)
        : [...QUICK_VIEW_ZOOM_STEPS].reverse().find((candidate) => candidate < value - 0.001);
    if (next !== undefined) setZoom(next);
  };
  const close = () => {
    if (dialog.open) dialog.close();
    returnFocus(opener, openerRing);
    props.onClose();
  };

  // A key belongs to the view while focus is inside it, or on the page with no other dialog open above it.
  const ownsKey = (target: EventTarget | null) =>
    target instanceof Node &&
    (dialog.contains(target) ||
      (target === document.body && Array.from(document.querySelectorAll("dialog[open]")).every((open) => open === dialog)));
  const keys = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !ownsKey(event.target)) return;
    const inDocument = event.target instanceof Element && Boolean(event.target.closest('[role="document"]'));
    const handled = (() => {
      switch (event.key) {
        case "Escape":
          close();
          return true;
        case " ":
          if (interactive(event.target)) return false;
          close();
          return true;
        case "ArrowLeft":
          step(-1);
          return true;
        case "ArrowRight":
          step(1);
          return true;
        case "ArrowUp":
          if (inDocument) return false;
          step(-1);
          return true;
        case "ArrowDown":
          if (inDocument) return false;
          step(1);
          return true;
        case "+":
        case "=":
          zoomBy(1);
          return true;
        case "-":
          zoomBy(-1);
          return true;
        case "0":
          setZoom(1);
          return true;
        default:
          return false;
      }
    })();
    if (handled) event.preventDefault();
  };

  let touchX: number | null = null;
  let touchY = 0;
  const touchStart = (event: TouchEvent) => {
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    touchX = touch && zoom() === 1 ? touch.clientX : null;
    touchY = touch?.clientY ?? 0;
  };
  const touchEnd = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    if (touchX === null || !touch) return;
    const dx = touch.clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(touch.clientY - touchY)) step(dx < 0 ? 1 : -1);
  };
  // A press on the empty stage, outside the item, closes like a press beside a dialog.
  let scroller!: HTMLDivElement;
  const stagePress = (event: MouseEvent) => {
    if (event.target === scroller || event.target === dialog) close();
  };

  // Registration and teardown both live in onMount: onCleanup also runs when an SSR render is disposed.
  onMount(() => {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openerRing = ringOnReturn(opener);
    opener?.blur();
    dialog.showModal();
    // The item has the focus, not the first command: the keys step and zoom at once, and no ring lands on Download.
    scroller.focus({ preventScroll: true });
    document.addEventListener("keydown", keys);
    onCleanup(() => document.removeEventListener("keydown", keys));
  });

  return (
    <dialog
      ref={dialog}
      class="k2b-quick-view"
      aria-label={t().quickView({ name: item()?.name ?? "" })}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onMouseDown={stagePress}
      onTouchStart={touchStart}
      onTouchEnd={touchEnd}
    >
      <div class="k2b-quick-view__top">
        <p class="k2b-quick-view__name k2b-overlay-surface">
          <b onPointerEnter={showTruncatedTitle}>{item()?.name}</b>
          <Show when={item()?.facts}>
            <span>{item()?.facts}</span>
          </Show>
        </p>
        <div class="k2b-quick-view__actions">
          <For each={item() ? (props.actions?.(item()!) ?? []) : []}>
            {(action) => (
              <IconButton class="k2b-quick-view__action k2b-overlay-surface" variant="ghost" label={action.label} onClick={action.onClick}>
                <i class={action.icon} aria-hidden="true" />
              </IconButton>
            )}
          </For>
          <IconButton
            class="k2b-quick-view__action k2b-overlay-surface"
            variant="ghost"
            label={t().close}
            tooltip={t().closeHint}
            onClick={close}
          >
            <i class="ti ti-x" aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <div class="k2b-quick-view__stage" data-zoomed={zoom() !== 1 ? "" : undefined}>
        <div ref={scroller} class="k2b-quick-view__scroller" tabIndex={-1}>
          {/* Keyed by id: the stage mounts once per item, also when the host hands in a new object for it. */}
          <Show keyed when={item()?.id}>
            {(_id) => props.children(untrack(item)!, zoom)}
          </Show>
        </div>
      </div>
      <div class="k2b-quick-view__bar">
        <Toolbar label={t().zoom}>
          <Toolbar.Action label={t().previous} icon="ti ti-chevron-left" disabled={props.items.length < 2} onClick={() => step(-1)} />
          <Toolbar.Label class="k2b-quick-view__count">
            <span class="k2b-sr-only" aria-live="polite">
              {t().position({ index: index() + 1, total: props.items.length })}
            </span>
            <span aria-hidden="true">
              {index() + 1} / {props.items.length}
            </span>
          </Toolbar.Label>
          <Toolbar.Action label={t().next} icon="ti ti-chevron-right" disabled={props.items.length < 2} onClick={() => step(1)} />
          <Toolbar.Separator />
          <Toolbar.Action
            label={t().zoomOut}
            icon="ti ti-minus"
            disabled={!zoomable() || zoom() <= QUICK_VIEW_ZOOM_STEPS[0]}
            onClick={() => zoomBy(-1)}
          />
          <Toolbar.Label class="k2b-quick-view__percent">
            <span aria-live="polite">{t().percent({ value: Math.round(zoom() * 100) })}</span>
          </Toolbar.Label>
          <Toolbar.Action
            label={t().zoomIn}
            icon="ti ti-plus"
            disabled={!zoomable() || zoom() >= QUICK_VIEW_ZOOM_STEPS[QUICK_VIEW_ZOOM_STEPS.length - 1]!}
            onClick={() => zoomBy(1)}
          />
        </Toolbar>
      </div>
      <Show when={props.items.length > 1}>
        <ThumbnailStrip
          class="k2b-quick-view__strip"
          label={t().items}
          items={props.items.map((entry) => ({ id: entry.id, name: entry.name, thumbnail: entry.thumbnail }))}
          currentItem={props.current}
          onSelectItem={props.onCurrentChange}
        />
      </Show>
    </dialog>
  );
}

export default QuickView;
