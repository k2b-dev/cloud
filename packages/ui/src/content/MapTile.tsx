import { createEffect, type JSX, onCleanup, Show, untrack } from "solid-js";
import { dialogCore, type OpenDialogOptions } from "../feedback/dialog-core";
import { LocaleProvider, useLocale } from "../intl/locale";
import { panelDialogWorkspacePanelClass } from "../layout/PanelDialog";

/** The query parameter that names the open map dialog, so a reload opens it again. */
export const MAP_DIALOG_PARAM = "map";

/** Dialog options for MapDialog: a large dialog, the whole screen below 48rem; Back closes it. */
export const mapDialogOptions = {
  panelClassName: `${panelDialogWorkspacePanelClass} k2b-map-dialog-frame`,
  contentClassName: "k2b-panel-dialog-viewport is-workspace",
  history: true,
} satisfies OpenDialogOptions;

export type MapTileProps = {
  /** Accessible name of the whole tile, such as "Open map: Delivery Thursday, 86.4 km, 4 stops". */
  label: string;
  /** The short summary in the pill, such as "86.4 km · 1 h 32 min · A → B → C". */
  summary: JSX.Element;
  /** The places are still loading: the pill shows progress and the tile does not open yet. */
  loading?: boolean;
  /** Renders the dialog content, normally a MapDialog; `close` closes the dialog. */
  dialog: (close: () => void) => JSX.Element;
  /**
   * A stable id of this map on the page. While its dialog is open the URL carries `?map=<restoreId>`, and a reload
   * opens the dialog again. Omit it for maps without a stable id; their dialog stays closed after a reload.
   */
  restoreId?: string;
  /** The still map, for example `<MapView still … />`, in the size of the tile. */
  children: JSX.Element;
  class?: string;
};

const urlParam = () => new URL(location.href).searchParams.get(MAP_DIALOG_PARAM);
const urlWith = (value: string | undefined) => {
  const url = new URL(location.href);
  if (value === undefined) url.searchParams.delete(MAP_DIALOG_PARAM);
  else url.searchParams.set(MAP_DIALOG_PARAM, value);
  return url.pathname + url.search + url.hash;
};

/**
 * A small map that is one button: the map image with a summary pill on it. Activating it opens the full map in a
 * dialog. Back, Escape, and the close button close the dialog; focus returns to the tile.
 */
export function MapTile(props: MapTileProps): JSX.Element {
  const locale = useLocale();
  let button!: HTMLButtonElement;
  let open = false;
  // The dialog belongs to this tile: a tile that goes away takes its dialog along.
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const show = async () => {
    if (open || props.loading) return;
    open = true;
    const restore = props.restoreId;
    // The dialog returns focus to the element focused when it opened; Safari leaves focus where it was on a click.
    button.focus({ preventScroll: true });
    try {
      // Only the dialog's own entry names the map, so Back and close land on the page without the name.
      await dialogCore.open<void>(
        (_close, context) => <LocaleProvider locale={locale()}>{props.dialog(() => void context.requestDismiss())}</LocaleProvider>,
        { ...mapDialogOptions, signal: lifetime.signal, historyUrl: restore === undefined ? undefined : urlWith(restore) },
      );
    } finally {
      open = false;
      // Opened from a link that already named the map: its page entry drops the name once the dialog closed.
      if (restore !== undefined && !lifetime.signal.aborted && urlParam() === restore)
        history.replaceState(history.state, "", urlWith(undefined));
    }
  };
  // A reload with this map's name in the URL opens the dialog again, once the places have loaded.
  let restored = false;
  createEffect(() => {
    if (restored || props.loading || props.restoreId === undefined || urlParam() !== props.restoreId) return;
    restored = true;
    void untrack(show);
  });
  return (
    <div class={`k2b-map-tile${props.class ? ` ${props.class}` : ""}`} data-loading={props.loading || undefined}>
      {props.children}
      <button
        ref={button}
        type="button"
        class="k2b-map-tile__open"
        aria-label={props.label}
        disabled={props.loading}
        onClick={() => void show()}
      >
        <span class="k2b-map-tile__summary">
          <span>
            <Show when={props.loading}>
              <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
            </Show>
            {props.summary}
          </span>
          <Show when={!props.loading}>
            <i class="ti ti-arrows-maximize" aria-hidden="true" />
          </Show>
        </span>
      </button>
    </div>
  );
}
