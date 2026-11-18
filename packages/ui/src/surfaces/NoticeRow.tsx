import { children, createSignal, For, type JSX, onCleanup, onMount, Show, splitProps } from "solid-js";
import { dialogToneIcon, dialogToneLabel } from "../feedback/dialog-tone";
import { useUiMessages } from "../intl/messages";
import type { NoticeTone } from "./NoticeCard";

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
  /** The one next step at the end of the row, such as a `Button` or a `SplitButton`. It never wraps below the text. */
  action?: JSX.Element;
  class?: string;
};

/**
 * A notice with an optional quiet line. Without it, one row of at least 48px: the tile, one line of text, then the action, all centred. It has the tint and
 * tones of `NoticeCard`, so a notice that changes state in place, such as blocked, loading, and failed, keeps its row and
 * the content below never moves.
 */
export function NoticeRow(props: NoticeRowProps): JSX.Element {
  if (
    props.detail !== undefined ||
    props.icon ||
    props.reserve !== undefined ||
    props.actions !== undefined ||
    props.detailAction !== undefined
  )
    return <NoticeSummary {...props} />;
  const [local, articleProps] = splitProps(props, [
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
  ]);
  return (
    <article {...articleProps} class={`k2b-notice-card ${local.class ?? ""}`} data-tone={local.tone ?? "neutral"} data-row="">
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
}

/** The two-line form of NoticeRow; the original subject-tile row keeps its markup and inline action. */
function NoticeSummary(props: NoticeRowProps): JSX.Element {
  const [local, articleProps] = splitProps(props, [
    "tone",
    "icon",
    "tile",
    "tileColor",
    "children",
    "detail",
    "detailTitle",
    "detailAction",
    "reserve",
    "detailLines",
    "actions",
    "action",
    "class",
  ]);
  let host: HTMLDivElement | undefined;
  const [narrow, setNarrow] = createSignal(false);
  const messages = useUiMessages();
  const dialogTone = () => (local.tone === "success" || local.tone === "warning" || local.tone === "danger" ? local.tone : undefined);
  const icon = () => {
    if (local.icon !== true) return local.icon;
    const tone = dialogTone();
    return tone ? dialogToneIcon(tone) : "ti ti-info-circle";
  };
  const toneWord = () => {
    const tone = local.icon === true ? dialogTone() : undefined;
    return tone ? `${dialogToneLabel(messages(), tone)}: ` : undefined;
  };
  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      const breakpoint = 35 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      setNarrow((entry?.contentRect.width ?? 0) <= breakpoint);
    });
    if (host) observer.observe(host);
    onCleanup(() => observer.disconnect());
  });
  const actions = children(() =>
    typeof local.actions === "function" ? local.actions({ narrow: narrow() }) : (local.actions ?? local.action),
  );
  // Buttons may return an empty tooltip marker; it must not create a third action column.
  const rendersAction = (node: unknown) =>
    typeof Node !== "undefined" && node instanceof Node
      ? node.nodeType === Node.ELEMENT_NODE || Boolean(node.textContent?.trim())
      : node != null && typeof node !== "boolean" && node !== "";
  return (
    <div class="k2b-notice-card-container" ref={host}>
      <article
        {...articleProps}
        class={`k2b-notice-card ${local.class ?? ""}`}
        data-tone={local.tone ?? "neutral"}
        data-row=""
        data-detail=""
        data-detail-lines={local.detailLines === 2 ? "2" : undefined}
        data-row-icon={icon() || local.tile ? "" : undefined}
        data-row-tile={local.tile ? "" : undefined}
        data-reserve={local.reserve !== false ? "" : undefined}
      >
        <Show
          when={local.tile}
          fallback={<Show when={icon()}>{(value) => <i class={`${value()} k2b-notice-card__icon`} aria-hidden="true" />}</Show>}
        >
          {(tile) => (
            <span class="k2b-notice-card__tile k2b-icon-tile" style={{ color: local.tileColor }} aria-hidden="true">
              <i class={tile()} />
            </span>
          )}
        </Show>
        <div class="k2b-notice-card__content">
          <p class="k2b-notice-card__title">
            {toneWord() ? <span class="k2b-sr-only">{toneWord()}</span> : null}
            {local.children}
          </p>
          <p class="k2b-notice-card__description" title={local.detailTitle}>
            <span class="k2b-notice-card__detail-text">{local.detail}</span>
            <Show when={local.detailAction}>{(action) => <span class="k2b-notice-card__detail-action">{action()}</span>}</Show>
          </p>
        </div>
        <Show when={actions.toArray().some(rendersAction)}>
          <div class="k2b-notice-card__actions">
            <For each={actions.toArray().filter(rendersAction)}>{(action) => <div class="k2b-notice-card__action-slot">{action}</div>}</For>
          </div>
        </Show>
      </article>
    </div>
  );
}
