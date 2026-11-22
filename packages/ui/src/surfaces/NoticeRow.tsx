import { createSignal, type JSX, onCleanup, onMount, Show, splitProps } from "solid-js";
import { NoticeCard, type NoticeTone } from "./NoticeCard";

export type NoticeRowProps = Omit<JSX.HTMLAttributes<HTMLElement>, "children" | "class"> & {
  tone?: NoticeTone;
  /**
   * A Tabler icon class on a soft square tile at the start of the row, for the subject the notice is about, such as
   * images. The tile is decorative; the text names the state.
   */
  tile?: string;
  /** The tile's colour as a CSS colour, such as a subject token; defaults to the tone's ink. */
  tileColor?: string;
  /** A decorative icon; true resolves the tone's icon and its screen-reader word. */
  icon?: string | true;
  /** A quiet second line opts into the responsive summary: desktop action column, phone actions below. */
  detail?: JSX.Element;
  detailTitle?: string;
  /** A quiet text action that remains visible when the detail is truncated. */
  detailAction?: JSX.Element;
  /** Keep room for two title lines, two quiet lines and phone controls through transitions. */
  reserve?: boolean;
  detailLines?: 1 | 2;
  /** One or two public controls. The renderer selects their variants and sizes for the container width. */
  actions?: JSX.Element | ((layout: { narrow: boolean }) => JSX.Element);
  /** One short sentence; truncate it rather than letting the row grow. */
  children: JSX.Element;
  /**
   * The one next step at the end of the row, such as a `Button` or a `SplitButton`. It never wraps below the text. With
   * `icon`, `detail`, or `actions` it stands after those controls; it is never dropped.
   */
  action?: JSX.Element;
  class?: string;
};

const ROW_PROPS = [
  "tone",
  "tile",
  "tileColor",
  "children",
  "action",
  "class",
  "icon",
  "detail",
  "detailTitle",
  "detailAction",
  "reserve",
  "detailLines",
  "actions",
] as const;

/**
 * A notice with an optional quiet line. Without it, one row of at least 48px: the tile, one line of text, then the action, all centred. It has the tint and
 * tones of `NoticeCard`, so a notice that changes state in place, such as blocked, loading, and failed, keeps its row and
 * the content below never moves.
 * The one- or two-line form is chosen once at mount. Keep that form stable across state changes.
 * In the two-line form use `actions`; `action` belongs to the original single-line form.
 */
export function NoticeRow(props: NoticeRowProps): JSX.Element {
  const [local, articleProps] = splitProps(props, ROW_PROPS);
  if (
    !(
      props.detail !== undefined ||
      props.icon ||
      props.reserve !== undefined ||
      props.actions !== undefined ||
      props.detailAction !== undefined
    )
  )
    return (
      <article
        {...articleProps}
        class={`k2b-notice-card ${local.class ?? ""}`}
        data-tone={local.tone ?? "neutral"}
        data-k2b-band="cell"
        data-row=""
      >
        <Show when={local.tile}>
          {(tile) => (
            <span class="k2b-notice-card__tile k2b-icon-tile" style={{ color: local.tileColor }} aria-hidden="true">
              <i class={tile()} />
            </span>
          )}
        </Show>
        <div class="k2b-notice-card__content">{local.children}</div>
        <Show when={local.action}>{(action) => <div class="k2b-notice-card__action">{action()}</div>}</Show>
      </article>
    );
  let host: HTMLDivElement | undefined;
  const [narrow, setNarrow] = createSignal(false);
  onMount(() => {
    if (!host) return;
    const isNarrow = (width: number) => width <= 35 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    // Receipts size to their content: choose the controls before the first paint. Later changes must not resize the
    // observed box inside the observer's callback, which would create a resize loop.
    const width = host.getBoundingClientRect().width;
    if (host.isConnected && width > 0) setNarrow(isNarrow(width));
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const next = isNarrow(entry?.contentRect.width ?? 0);
      cancelAnimationFrame(frame);
      if (next !== narrow()) frame = requestAnimationFrame(() => setNarrow(next));
    });
    observer.observe(host);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    });
  });
  return (
    <div class="k2b-notice-card-container" data-k2b-band="cell" ref={host} style={{ "--k2b-notice-tile-color": local.tileColor }}>
      <NoticeCard
        {...articleProps}
        class={local.class}
        tone={local.tone}
        layout="card"
        icon={local.tile ?? local.icon}
        data-row=""
        data-detail=""
        data-detail-lines={local.detailLines === 2 ? "2" : undefined}
        data-row-tile={local.tile ? "" : undefined}
        data-reserve={local.reserve !== false ? "" : undefined}
        title={local.children}
        detail={
          <>
            <span class="k2b-notice-card__detail-text" title={local.detailTitle}>
              {local.detail}
            </span>
            <Show when={local.detailAction}>{(action) => <span class="k2b-notice-card__detail-action">{action()}</span>}</Show>
          </>
        }
        actions={
          <>
            {typeof local.actions === "function" ? local.actions({ narrow: narrow() }) : local.actions}
            {local.action}
          </>
        }
      />
    </div>
  );
}
