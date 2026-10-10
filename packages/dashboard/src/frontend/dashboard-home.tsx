import type { DashboardWidgetSize } from "@k2b/cloud/contracts";
import { openAppLaunchpad } from "@k2b/cloud/ssr/islands";
import { announce, Button, Placeholder, SegmentedControl, Tooltip, toast, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../api/client";
import {
  DASHBOARD_MAX_ITEMS,
  DASHBOARD_MAX_SHORTCUTS,
  type DashboardAppSummary,
  type DashboardBoardEntry,
  type DashboardCatalogWidget,
  type DashboardKeptEntry,
  type DashboardLegalLink,
  type DashboardShortcut,
  defaultDashboardBoard,
  restoreKeptDashboardEntries,
} from "../shared";
import { openDashboardGallery } from "./dashboard-gallery";
import { askForShortcut, DashboardShortcuts } from "./dashboard-shortcuts";
import { DashboardWidgetFrame } from "./dashboard-tile";
import { dashboardMessages } from "./messages";
import { type DashboardTiles, loadDashboardWidgets } from "./widget-board";

export type DashboardHomeProps = {
  greeting: string;
  /** Today's date in the person's locale and time zone, written by the server. */
  today: string;
  apps: DashboardAppSummary[];
  legalLinks: DashboardLegalLink[];
  shortcuts: DashboardShortcut[];
  /** Every widget the person may use. */
  catalog: DashboardCatalogWidget[];
  /** The widgets the page shows, in reading order and in sizes they offer. */
  board: DashboardBoardEntry[];
  /** Saved widgets the page cannot show now; saving the board keeps them at their places. */
  kept: DashboardKeptEntry[];
  /** The person has not arranged their own board and sees the default one. */
  followsDefault: boolean;
};

/** A press this long on a widget opens the edit mode. */
const LONG_PRESS_MS = 550;
/** On a touch screen a widget is picked up after this hold, so a swipe over the board still scrolls it. */
const TOUCH_PICK_UP_MS = 250;
/** A pointer that moves this far before a long press or a pick-up is a scroll or a click, not a press. */
const PRESS_TOLERANCE_PX = 8;
const DRAG_THRESHOLD_PX = 6;
const AUTO_SCROLL_EDGE_PX = 56;
const MOVE_MS = 180;
/** The device-scoped hint cookie of the board before every widget kept its own frame; it no longer means anything. */
const RETIRED_HINT_COOKIE = "dashboard_widgets=; path=/app/dashboard; max-age=0; samesite=lax";

type Snapshot = { board: DashboardBoardEntry[]; shortcuts: DashboardShortcut[]; followsDefault: boolean };

type Press = {
  pointerId: number;
  key: string;
  tile: HTMLElement;
  x: number;
  y: number;
  /** The pointer may drag the widget: at once with a mouse or pen, after a hold on a touch screen. */
  armed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  drag?: { ghost: HTMLElement; offsetX: number; offsetY: number; lastOver?: string; frame?: number };
};

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const scrollContainerOf = (element: HTMLElement): HTMLElement => {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
};

/**
 * The dashboard: greeting, shortcuts, and one board of widgets in reading order. "Edit" or a long press on a widget
 * opens the edit mode, where widgets are dragged, moved with the arrow keys, resized, removed, and added from the
 * gallery; "Done" saves the board without reloading the page.
 */
export default function DashboardHome(props: DashboardHomeProps) {
  const locale = useLocale();
  const t = () => dashboardMessages.resolve([locale()]).t;
  const catalogByKey = new Map(props.catalog.map((widget) => [widget.key, widget]));
  const [board, setBoard] = createSignal<DashboardBoardEntry[]>(props.board);
  const [shortcuts, setShortcuts] = createSignal<DashboardShortcut[]>(props.shortcuts);
  const [followsDefault, setFollowsDefault] = createSignal(props.followsDefault);
  const [kept, setKept] = createSignal<DashboardKeptEntry[]>(props.kept);
  const [editing, setEditing] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  /** The board can change only in the edit mode and not while Done saves it, so what is saved is what is shown. */
  const editable = () => editing() && !saving();
  const [tiles, setTiles] = createSignal<DashboardTiles>(
    Object.fromEntries(props.board.map((entry) => [entry.key, { status: "loading" }])),
  );
  const [dragged, setDragged] = createSignal<string>();
  const [fresh, setFresh] = createSignal<string>();
  let snapshot: Snapshot | undefined;
  let grid: HTMLElement | undefined;
  let root: HTMLDivElement | undefined;
  // Edit and Done replace each other in the header, so each hands the keyboard focus to the other.
  let editButton: HTMLButtonElement | undefined;
  let doneButton: HTMLButtonElement | undefined;

  const keys = () => board().map((entry) => entry.key);
  /** Widgets the page cannot show count too: saving keeps them. */
  const boardIsFull = () => board().length + kept().length >= DASHBOARD_MAX_ITEMS;
  const sizeOf = (key: string): DashboardWidgetSize => board().find((entry) => entry.key === key)?.size ?? "medium";
  const titleOf = (key: string) => catalogByKey.get(key)?.title ?? key;
  const tileElement = (key: string) => grid?.querySelector<HTMLElement>(`.dashboard-tile[data-key="${CSS.escape(key)}"]`) ?? undefined;

  // ── Loading ───────────────────────────────────────────────────────────
  // The newest request for a widget owns its frame; the size each widget was last asked in decides whether a resize
  // asks again.
  const generation = new Map<string, number>();
  const askedSize = new Map<string, DashboardWidgetSize>();
  const requests = new Set<AbortController>();
  const load = (entries: readonly DashboardBoardEntry[], options: { quiet?: boolean } = {}) => {
    if (entries.length === 0) return;
    const controller = new AbortController();
    requests.add(controller);
    const owned = new Map<string, number>();
    for (const entry of entries) {
      const next = (generation.get(entry.key) ?? 0) + 1;
      generation.set(entry.key, next);
      owned.set(entry.key, next);
      askedSize.set(entry.key, entry.size);
    }
    // A quiet reload keeps the widget's content until the new answer replaces it.
    setTiles((current) => ({
      ...current,
      ...Object.fromEntries(
        entries.filter((entry) => !options.quiet || current[entry.key]?.status !== "ok").map((entry) => [entry.key, { status: "loading" }]),
      ),
    }));
    void loadDashboardWidgets({
      widgets: entries,
      signal: controller.signal,
      locale: locale(),
      onTile: (key, state) => {
        if (generation.get(key) === owned.get(key)) setTiles((current) => ({ ...current, [key]: state }));
      },
    }).finally(() => requests.delete(controller));
  };
  /** Asks every widget on the board that has not answered in its current size yet. */
  const loadMissing = () =>
    load(
      board().filter((entry) => askedSize.get(entry.key) !== entry.size),
      { quiet: true },
    );
  const retry = (key: string) => {
    tileElement(key)?.focus({ preventScroll: true });
    load([{ key, size: sizeOf(key) }]);
  };

  onMount(() => {
    document.cookie = RETIRED_HINT_COOKIE;
    load(board());
  });
  onCleanup(() => {
    for (const controller of requests) controller.abort();
  });

  // ── Editing ───────────────────────────────────────────────────────────
  /** Moves every widget whose place changed from where it was, so the board visibly makes room. */
  const flip = (mutate: () => void) => {
    const before = new Map(
      [...(grid?.querySelectorAll<HTMLElement>(".dashboard-tile") ?? [])].map((el) => [el, el.getBoundingClientRect()]),
    );
    mutate();
    if (reducedMotion()) return;
    for (const [el, from] of before) {
      if (!el.isConnected) continue;
      const to = el.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (dx === 0 && dy === 0) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: MOVE_MS,
        easing: "cubic-bezier(.2,.7,.2,1)",
      });
    }
  };
  const change = (next: DashboardBoardEntry[]) => {
    flip(() => setBoard(next));
    setFollowsDefault(false);
  };

  const startEdit = () => {
    if (editing()) return;
    snapshot = { board: board(), shortcuts: shortcuts(), followsDefault: followsDefault() };
    setEditing(true);
    announce(t().editing);
  };
  const leaveEdit = () => {
    snapshot = undefined;
    setEditing(false);
    setFresh(undefined);
    editButton?.focus({ preventScroll: true });
  };
  const cancel = () => {
    if (snapshot) {
      const previous = snapshot;
      flip(() => setBoard(previous.board));
      setShortcuts(previous.shortcuts);
      setFollowsDefault(previous.followsDefault);
      loadMissing();
    }
    leaveEdit();
    announce(t().discarded);
  };
  const done = async () => {
    if (saving()) return;
    const previous = snapshot;
    const unchanged =
      previous &&
      previous.followsDefault === followsDefault() &&
      JSON.stringify([previous.board, previous.shortcuts]) === JSON.stringify([board(), shortcuts()]);
    if (!unchanged) {
      setSaving(true);
      let saved = false;
      try {
        const response = await apiClient.settings.$put({
          json: { shortcuts: shortcuts(), board: followsDefault() ? null : restoreKeptDashboardEntries(board(), kept()) },
        });
        saved = response.ok;
      } catch {
        // A failed request is reported like a refused one.
      }
      setSaving(false);
      if (!saved) {
        // Done was disabled while it saved, which took the focus from it.
        doneButton?.focus({ preventScroll: true });
        toast.error(t().saveFailed);
        return;
      }
      // The default board keeps no widgets of its own, so a later board starts without them too.
      if (followsDefault()) setKept([]);
    }
    leaveEdit();
    announce(t().saved);
  };
  const resetToDefault = () => {
    if (!editable()) return;
    flip(() => setBoard(defaultDashboardBoard(props.catalog)));
    setFollowsDefault(true);
    loadMissing();
    announce(t().wasReset);
  };

  const move = (key: string, to: number) => {
    if (!editable()) return false;
    const current = board();
    const from = current.findIndex((entry) => entry.key === key);
    if (from < 0 || to < 0 || to >= current.length || to === from) return false;
    const next = [...current];
    const [entry] = next.splice(from, 1);
    next.splice(to, 0, entry!);
    change(next);
    return true;
  };
  const remove = (key: string) => {
    if (!editable()) return;
    const index = keys().indexOf(key);
    if (index < 0) return;
    change(board().filter((entry) => entry.key !== key));
    const next = grid?.querySelectorAll<HTMLElement>(".dashboard-tile")[Math.min(index, board().length - 1)];
    (next ?? grid?.querySelector<HTMLElement>(".dashboard-add-tile"))?.focus();
    announce(t().removed({ name: titleOf(key) }));
  };
  const resize = (key: string, size: DashboardWidgetSize) => {
    if (!editable()) return;
    change(board().map((entry) => (entry.key === key ? { key, size } : entry)));
    loadMissing();
    announce(t().resized({ name: titleOf(key), size: t()[size] }));
  };

  const refuseWhenFull = () => {
    if (!boardIsFull()) return false;
    toast(t().boardFull({ max: DASHBOARD_MAX_ITEMS }));
    return true;
  };
  const openGallery = async () => {
    if (saving() || refuseWhenFull()) return;
    const choice = await openDashboardGallery(
      {
        catalog: props.catalog,
        onBoard: new Set(keys()),
        seed: (key, size) => (askedSize.get(key) === size && tiles()[key]?.status === "ok" ? tiles()[key] : undefined),
      },
      locale(),
    );
    if (!choice || saving() || keys().includes(choice.key) || refuseWhenFull()) return;
    startEdit();
    change([...board(), choice]);
    setFresh(choice.key);
    load([choice]);
    const tile = tileElement(choice.key);
    tile?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    tile?.focus({ preventScroll: true });
    announce(t().added({ name: titleOf(choice.key), position: board().length, total: board().length }));
  };
  const addShortcut = async () => {
    if (!editable()) return;
    // The settings accept no more, so one more would make the whole board unsavable.
    if (shortcuts().length >= DASHBOARD_MAX_SHORTCUTS) {
      toast(t().shortcutsFull({ max: DASHBOARD_MAX_SHORTCUTS }));
      return;
    }
    const shortcut = await askForShortcut(props.apps, t().addShortcut);
    if (shortcut && editable() && shortcuts().length < DASHBOARD_MAX_SHORTCUTS) setShortcuts([...shortcuts(), shortcut]);
  };
  const openApps = () =>
    openAppLaunchpad(
      props.apps.map((app) => ({
        id: app.id,
        iconClass: app.icon,
        label: app.name,
        href: app.href,
        description: app.description,
        badge: app.badge,
      })),
      props.legalLinks,
    );

  // ── Keyboard ──────────────────────────────────────────────────────────
  const onTileKeyDown = (event: KeyboardEvent, key: string) => {
    if (!editable() || event.target !== event.currentTarget) return;
    const index = keys().indexOf(key);
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      remove(key);
      return;
    }
    const offset =
      event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0;
    if (offset === 0) return;
    event.preventDefault();
    if (!move(key, index + offset)) return;
    // Moving a focused element in the document drops its focus.
    tileElement(key)?.focus();
    announce(t().moved({ name: titleOf(key), position: index + offset + 1, total: board().length }));
  };

  // ── Pointer: long press, drag, touch ──────────────────────────────────
  let press: Press | undefined;
  let suppressClick = false;
  const endPress = () => {
    if (!press) return;
    clearTimeout(press.timer);
    const drag = press.drag;
    if (drag) {
      if (drag.frame !== undefined) cancelAnimationFrame(drag.frame);
      drag.ghost.remove();
      setDragged(undefined);
      const index = keys().indexOf(press.key);
      announce(t().moved({ name: titleOf(press.key), position: index + 1, total: board().length }));
      tileElement(press.key)?.focus({ preventScroll: true });
    }
    press = undefined;
  };
  const hitTest = (x: number, y: number) => {
    if (!press?.drag || !grid) return;
    const over = document
      .elementsFromPoint(x, y)
      .map((node) => (node as HTMLElement).closest?.<HTMLElement>(".dashboard-tile"))
      .find((tile) => tile && tile.parentElement === grid && tile.dataset.key !== press?.key);
    const key = over?.dataset.key;
    // A widget that just made room may still be under the pointer; it trades places again only after the pointer left it.
    if (!key || key === press.drag.lastOver) {
      if (!key) press.drag.lastOver = undefined;
      return;
    }
    if (move(press.key, keys().indexOf(key))) press.drag.lastOver = key;
  };
  const autoScroll = (y: number) => {
    if (!press?.drag || !grid) return;
    const scroller = scrollContainerOf(grid);
    const bounds = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
    const delta =
      y < bounds.top + AUTO_SCROLL_EDGE_PX
        ? -(bounds.top + AUTO_SCROLL_EDGE_PX - y)
        : y > bounds.bottom - AUTO_SCROLL_EDGE_PX
          ? y - (bounds.bottom - AUTO_SCROLL_EDGE_PX)
          : 0;
    if (press.drag.frame !== undefined) cancelAnimationFrame(press.drag.frame);
    press.drag.frame = undefined;
    if (delta === 0) return;
    const step = () => {
      if (!press?.drag) return;
      scroller.scrollBy(0, Math.max(-16, Math.min(16, delta / 3)));
      hitTest(lastX, lastY);
      press.drag.frame = requestAnimationFrame(step);
    };
    press.drag.frame = requestAnimationFrame(step);
  };
  let lastX = 0;
  let lastY = 0;
  const beginDrag = () => {
    if (!press || !root) return;
    const rect = press.tile.getBoundingClientRect();
    // A copy of the frame alone follows the pointer; it is no widget of the board.
    const ghost = document.createElement("div");
    ghost.className = "dashboard-tile-ghost";
    ghost.setAttribute("aria-hidden", "true");
    const frame = press.tile.querySelector(".dashboard-tile__frame");
    if (frame) ghost.append(frame.cloneNode(true));
    Object.assign(ghost.style, { width: `${rect.width}px`, height: `${rect.height}px`, left: `${rect.left}px`, top: `${rect.top}px` });
    root.append(ghost);
    press.drag = { ghost, offsetX: press.x - rect.left, offsetY: press.y - rect.top };
    setDragged(press.key);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button > 0 || press) return;
    suppressClick = false;
    const target = event.target as HTMLElement;
    const tile = target.closest<HTMLElement>(".dashboard-tile");
    const key = tile?.dataset.key;
    if (!tile || !key) return;
    const touch = event.pointerType === "touch";
    if (!editing()) {
      if (target.closest("button, input, textarea, select, [role='radio']")) return;
      press = { pointerId: event.pointerId, key, tile, x: event.clientX, y: event.clientY, armed: false };
      // A long press only opens the edit mode; moving then takes a new press. Browsers stop letting a page keep a
      // finger that has been held this long from scrolling, so the same press could not drag reliably.
      press.timer = setTimeout(() => {
        if (!press) return;
        endPress();
        startEdit();
        // The click that ends this press must not follow a link inside the widget.
        suppressClick = true;
        tile.focus({ preventScroll: true });
      }, LONG_PRESS_MS);
      return;
    }
    if (target.closest(".dashboard-tile__control") || saving()) return;
    press = { pointerId: event.pointerId, key, tile, x: event.clientX, y: event.clientY, armed: !touch };
    if (touch)
      press.timer = setTimeout(() => {
        if (press) press.armed = true;
      }, TOUCH_PICK_UP_MS);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.pointerId) return;
    lastX = event.clientX;
    lastY = event.clientY;
    const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (!press.armed) {
      if (distance > PRESS_TOLERANCE_PX) endPress();
      return;
    }
    if (!press.drag) {
      if (distance < DRAG_THRESHOLD_PX || !editing()) return;
      beginDrag();
    }
    const drag = press.drag!;
    drag.ghost.style.left = `${event.clientX - drag.offsetX}px`;
    drag.ghost.style.top = `${event.clientY - drag.offsetY}px`;
    hitTest(event.clientX, event.clientY);
    autoScroll(event.clientY);
  };
  const onPointerEnd = (event: PointerEvent) => {
    if (press && event.pointerId === press.pointerId) endPress();
  };
  // A widget picked up on a touch screen follows the finger instead of the page scrolling.
  const onTouchMove = (event: TouchEvent) => {
    if (press?.armed) event.preventDefault();
  };
  const onClickCapture = (event: MouseEvent) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  };
  const onContextMenu = (event: MouseEvent) => {
    if (press || editing()) event.preventDefault();
  };
  onMount(() => {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    grid?.addEventListener("touchmove", onTouchMove, { passive: false });
    grid?.addEventListener("click", onClickCapture, { capture: true });
    onCleanup(() => {
      endPress();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      grid?.removeEventListener("touchmove", onTouchMove);
      grid?.removeEventListener("click", onClickCapture, { capture: true });
    });
  });

  // ── View ──────────────────────────────────────────────────────────────
  const Tile = (tileProps: { key: string }) => {
    const widget = catalogByKey.get(tileProps.key)!;
    const state = () => tiles()[tileProps.key] ?? { status: "loading" as const };
    return (
      <div
        class="dashboard-tile"
        data-key={tileProps.key}
        data-size={sizeOf(tileProps.key)}
        data-state={state().status}
        data-dragging={dragged() === tileProps.key ? "true" : undefined}
        data-fresh={fresh() === tileProps.key ? "true" : undefined}
        tabIndex={editing() ? 0 : -1}
        role="group"
        aria-roledescription={t().widgetRole}
        aria-label={t().widgetLabel({ title: widget.title, app: widget.appName })}
        onKeyDown={(event) => onTileKeyDown(event, tileProps.key)}
      >
        <div class="dashboard-tile__frame" inert={editing()}>
          <DashboardWidgetFrame widget={widget} state={state()} onRetry={() => retry(tileProps.key)} />
        </div>
        <Show when={editing()}>
          <button
            type="button"
            class="dashboard-remove dashboard-tile__remove dashboard-tile__control"
            aria-label={t().removeNamed({ name: widget.title })}
            disabled={saving()}
            onClick={() => remove(tileProps.key)}
          >
            <i class="ti ti-x" aria-hidden="true" />
          </button>
          <Show when={widget.sizes.length > 1}>
            <div class="dashboard-tile__sizes dashboard-tile__control">
              <SegmentedControl<DashboardWidgetSize>
                size="sm"
                disabled={saving()}
                ariaLabel={t().sizeOf({ name: widget.title })}
                value={() => sizeOf(tileProps.key)}
                onValueChange={(size) => resize(tileProps.key, size)}
                options={widget.sizes.map((value) => ({ value, label: t()[value] }))}
              />
            </div>
          </Show>
        </Show>
      </div>
    );
  };

  return (
    <div ref={root} class="dashboard-page" data-editing={editing() ? "true" : undefined}>
      <header class="dashboard-head" style="view-transition-name: page-title">
        <div class="min-w-0">
          <p class="dashboard-head__date">{props.today}</p>
          <h1>{props.greeting}</h1>
        </div>
        <div class="dashboard-head__actions">
          <Show
            when={editing()}
            fallback={
              <>
                <Button variant="secondary" size="sm" onClick={openApps}>
                  <i class="ti ti-grid-dots" aria-hidden="true" />
                  <span class="dashboard-head__label">{t().apps}</span>
                </Button>
                <Button
                  ref={editButton}
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    startEdit();
                    doneButton?.focus({ preventScroll: true });
                  }}
                  aria-label={t().editDashboard}
                >
                  <i class="ti ti-pencil" aria-hidden="true" />
                  {t().edit}
                </Button>
              </>
            }
          >
            <div class="dashboard-edit-bar">
              <Tooltip.Anchor content={t().resetToDefaultLabel}>
                <Button variant="ghost" size="sm" onClick={resetToDefault} disabled={saving()}>
                  <i class="ti ti-arrow-back-up" aria-hidden="true" />
                  {t().resetToDefault}
                </Button>
              </Tooltip.Anchor>
              <Button variant="ghost" size="sm" onClick={cancel} disabled={saving()}>
                {t().cancel}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void openGallery()} disabled={saving()} aria-label={t().addWidget}>
                <i class="ti ti-plus" aria-hidden="true" />
                {t().addWidgetShort}
              </Button>
            </div>
            <Button ref={doneButton} size="sm" onClick={() => void done()} loading={saving()} loadingLabel={t().saving}>
              <i class="ti ti-check" aria-hidden="true" />
              {t().done}
            </Button>
          </Show>
        </div>
      </header>

      <DashboardShortcuts
        shortcuts={shortcuts()}
        apps={props.apps}
        editing={editing()}
        disabled={saving()}
        onRemove={(id) => setShortcuts(shortcuts().filter((shortcut) => shortcut.id !== id))}
        onAdd={() => void addShortcut()}
      />

      {/* The hint's line is always reserved, so entering the edit mode moves nothing. */}
      <p class="dashboard-edit-hint" data-shown={editing() ? "true" : undefined} aria-hidden={editing() ? undefined : "true"}>
        <i class="ti ti-hand-move" aria-hidden="true" />
        <span class="dashboard-edit-hint__pointer">{t().editHint}</span>
        <span class="dashboard-edit-hint__touch">{t().editHintTouch}</span>
      </p>

      <section ref={grid} class="dashboard-board" aria-label={t().widgetsLabel} onPointerDown={onPointerDown} onContextMenu={onContextMenu}>
        <For each={keys()}>{(key) => <Tile key={key} />}</For>
        <Show when={editing()}>
          <button type="button" class="dashboard-add-tile" disabled={saving()} onClick={() => void openGallery()}>
            <i class="ti ti-plus" aria-hidden="true" />
            {t().addWidget}
          </button>
        </Show>
        <Show when={!editing() && board().length === 0}>
          <Placeholder
            class="dashboard-board__empty"
            icon="ti ti-layout-dashboard"
            title={t().emptyBoard}
            action={
              <Button size="sm" onClick={() => void openGallery()}>
                <i class="ti ti-plus" aria-hidden="true" />
                {t().addWidget}
              </Button>
            }
          />
        </Show>
      </section>
    </div>
  );
}
