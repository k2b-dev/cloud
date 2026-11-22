import { i18n } from "@k2b/stdlib";
import { batch, createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show, untrack } from "solid-js";
import { useLocale } from "../intl/locale";
import type { DropOverlayProps, DropOverlayTile } from "./DropOverlay";
import { announce, currentPreview, type DragPayload, registerDropTarget, setDragStatus } from "./drag-and-drop";
import { useDragAndDropMessages } from "./drag-and-drop-messages";

/*
 * The overlay of drop targets (S7). It loads on demand: `DropOverlay` fetches it while the page is idle and on every
 * press of a drag source.
 */

/** Resting this long on a tile with a level opens it (S7). */
export const DWELL_MS = 450;
/** New tiles take nothing for this long, so a tile that appears under the pointer is never hit by accident (S7). */
export const ARM_MS = 220;
/** After a level change, resting opens a level only once the pointer has moved this far, so levels never cascade. */
const REST_SLOP = 6;

const dropOverlayMessages = /* @__PURE__ */ i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      label: "Drop targets",
      help: "Drag onto a target and let go · Esc cancels",
      rest: "Rest here to open",
      back: "Back",
      cancel: "Drop here: nothing happens",
    },
    de: {
      label: "Ziele zum Ablegen",
      help: "Auf ein Ziel ziehen und loslassen · Esc bricht ab",
      rest: "Kurz verweilen",
      back: "Zurück",
      cancel: "Hier loslassen: nichts passiert",
    },
  },
});
export const checkDropOverlayMessages = () => dropOverlayMessages.check();

type Tile = DropOverlayTile & { back?: boolean };

export function DropOverlayView(props: { overlay: DropOverlayProps; payload: () => DragPayload }): JSX.Element {
  const locale = useLocale();
  const t = () => dropOverlayMessages.resolve([locale()]).t;
  const dragMessages = useDragAndDropMessages();
  /** The levels above the current one, for "Back". */
  const [path, setPath] = createSignal<string[]>([]);
  const [level, setLevel] = createSignal("root");
  const [armed, setArmed] = createSignal(false);
  let root!: HTMLDivElement;
  let cancel!: HTMLDivElement;
  let armTimer = 0;
  /** The pointer's last place over the overlay, and where it was when the level opened. */
  let pointer: { x: number; y: number } | undefined;
  let openedAt: { x: number; y: number } | undefined;
  const moved = () => !openedAt || !pointer || Math.hypot(pointer.x - openedAt.x, pointer.y - openedAt.y) >= REST_SLOP;
  const arm = () => {
    setArmed(false);
    window.clearTimeout(armTimer);
    armTimer = window.setTimeout(() => setArmed(true), ARM_MS);
  };
  onCleanup(() => window.clearTimeout(armTimer));
  arm();
  const open = (next: string, back: boolean) => {
    openedAt = pointer;
    batch(() => {
      arm();
      if (back) setPath((all) => all.slice(0, -1));
      else setPath((all) => [...all, level()]);
      setLevel(next);
    });
  };
  const current = createMemo(() => props.overlay.level(level(), props.payload()));
  /** Keyed by `id`: a tile whose words stay the same keeps its element, also when the host's data updates. */
  const tiles = createMemo<Tile[]>((previous) => {
    const above = path().at(-1);
    const back: Tile[] =
      above === undefined ? [] : [{ id: "k2b-back", label: t().back, icon: "ti ti-arrow-left", opens: above, back: true }];
    const same = (a: Tile, b: Tile) =>
      a.label === b.label && a.description === b.description && a.disabled === b.disabled && a.opens === b.opens && a.icon === b.icon;
    return [...back, ...current().tiles].map(
      (tile) => previous.find((old) => old.id === tile.id && same(old, tile) && old.onDrop === tile.onDrop) ?? tile,
    );
  }, []);
  const status = (detail: string) => {
    const messages = dragMessages();
    const payload = props.payload();
    setDragStatus({ lead: messages.statusLead({ label: payload.label, count: payload.count ?? 1 }), detail });
  };
  // Over the overlay, the item is named in the top line; the preview shrinks to its icon and count.
  onMount(() => {
    const preview = currentPreview();
    preview?.setAttribute("data-compact", "");
    onCleanup(() => preview?.removeAttribute("data-compact"));
  });

  // Anywhere on the overlay outside a tile, letting go changes nothing; so does the marked area, which says so.
  onMount(() => {
    for (const element of [root, cancel]) {
      let inside = false;
      const target = registerDropTarget(element, {
        accept: props.overlay.accept,
        label: t().cancel,
        messages: dragMessages(),
        cancels: true,
        drop: () => {},
        hover: (point) => {
          if (point) pointer = point;
          if (!point) inside = false;
          else if (!inside) {
            inside = true;
            status(dragMessages().statusIdle);
            if (element === cancel) announce(root, dragMessages().over({ target: t().cancel }));
          }
          return undefined;
        },
      });
      onCleanup(() => target.dispose());
    }
  });

  const TileView = (tile: Tile) => {
    let element!: HTMLDivElement;
    let dwell = 0;
    let resting = false;
    let inside = false;
    const stop = () => {
      inside = false;
      resting = false;
      window.clearTimeout(dwell);
      delete element.dataset.dwell;
    };
    onCleanup(stop);
    // A tile takes part only once the level is armed; until then the overlay under it takes the pointer.
    createEffect(() => {
      if (!armed()) return;
      const target = untrack(() =>
        registerDropTarget(element, {
          accept: props.overlay.accept,
          label: tile.disabled ? `${tile.label} – ${tile.disabled}` : tile.label,
          messages: dragMessages(),
          disabled: tile.disabled !== undefined,
          cancels: !tile.onDrop,
          drop: (payload) => tile.onDrop?.(payload),
          hover: (point) => {
            if (!point) {
              stop();
              return undefined;
            }
            pointer = point;
            if (!inside) {
              inside = true;
              status(tile.onDrop ? dragMessages().statusOver({ target: tile.label }) : dragMessages().statusIdle);
              announce(root, dragMessages().over({ target: tile.label }));
            }
            // Resting opens the level only after the pointer moved since the last change, so a tile that appears
            // under a still pointer never opens by itself.
            if (!resting && tile.opens !== undefined && moved()) {
              resting = true;
              element.dataset.dwell = "";
              const opens = tile.opens;
              dwell = window.setTimeout(() => open(opens, tile.back === true), DWELL_MS);
            }
            return undefined;
          },
        }),
      );
      onCleanup(() => {
        stop();
        target.dispose();
      });
    });
    const description = () => tile.disabled ?? tile.description ?? (tile.opens !== undefined && !tile.back ? t().rest : undefined);
    return (
      <div
        ref={element}
        class="k2b-drop-overlay__tile"
        data-back={tile.back ? "" : undefined}
        aria-disabled={tile.disabled !== undefined ? "true" : undefined}
        style={{ "--k2b-drop-dwell": `${DWELL_MS}ms` }}
      >
        {tile.leading ?? <i class={`k2b-drop-overlay__icon ${tile.icon ?? "ti ti-circle-dot"}`} aria-hidden="true" />}
        <span class="k2b-drop-overlay__text">
          <span class="k2b-drop-overlay__label">{tile.label}</span>
          <Show when={description()}>{(text) => <span class="k2b-drop-overlay__description">{text()}</span>}</Show>
        </span>
        <Show when={tile.opens !== undefined && !tile.back}>
          <i class="ti ti-chevron-right k2b-drop-overlay__chevron" aria-hidden="true" />
        </Show>
        <Show when={tile.opens !== undefined}>
          <span class="k2b-drop-overlay__ring" aria-hidden="true" />
        </Show>
      </div>
    );
  };

  return (
    <div
      ref={root}
      class={`k2b-drop-overlay${props.overlay.class ? ` ${props.overlay.class}` : ""}`}
      role="region"
      aria-label={t().label}
      data-level={level() === "root" ? "root" : "inner"}
      data-arming={armed() ? undefined : ""}
    >
      <div class="k2b-drop-overlay__top">
        <i class="ti ti-hand-grab" aria-hidden="true" />
        <span class="k2b-drop-overlay__what">{props.payload().label}</span>
        <span class="k2b-drop-overlay__help">
          {t().help}
          {props.overlay.hint ? ` · ${props.overlay.hint}` : ""}
        </span>
      </div>
      <Show when={current().title}>{(title) => <div class="k2b-drop-overlay__title">{title()}</div>}</Show>
      <div class="k2b-drop-overlay__grid">
        <For each={tiles()}>{(tile) => TileView(tile)}</For>
      </div>
      <div ref={cancel} class="k2b-drop-overlay__cancel">
        <i class="ti ti-x" aria-hidden="true" />
        {t().cancel}
      </div>
    </div>
  );
}
