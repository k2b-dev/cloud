import { children, For, type JSX, Show, splitProps } from "solid-js";
import { dialogToneIcon, dialogToneLabel } from "../feedback/dialog-tone";
import { useUiMessages } from "../intl/messages";
import type { IntentTone } from "../semantics";

export type NoticeTone = Extract<IntentTone, "neutral" | "info" | "success" | "warning" | "danger">;

type NoticeCardContentProps =
  | { title: JSX.Element; detail?: JSX.Element; meta?: JSX.Element; children?: JSX.Element }
  | { title?: never; detail?: never; meta?: never; children: JSX.Element };

type NoticeCardLeadProps =
  | {
      /**
       * A Tabler icon class. Turns the notice into a compact status line whose icon and text take the tone colour. `true`
       * takes the tone's own icon, the one a toned dialog shows, and names the tone for screen readers.
       */
      icon?: string | true;
      tile?: never;
      tileColor?: never;
    }
  | {
      icon?: never;
      /**
       * A Tabler icon class on a soft square tile at the start of the notice, for the subject the notice is about, such
       * as images. The tile is decorative; the text names the state. It turns the notice into one row, like `action`.
       */
      tile: string;
      /** The tile's colour as a CSS colour, such as a subject token; defaults to the tone's ink. */
      tileColor?: string;
    };

export type NoticeCardProps = Omit<JSX.HTMLAttributes<HTMLElement>, "children" | "class" | "title"> &
  NoticeCardContentProps &
  NoticeCardLeadProps & {
    tone?: NoticeTone;
    /**
     * The one action at the end of the notice, such as a `Button` or a `SplitButton`. The notice becomes a single row,
     * at least 48 px high: the tile, the text, then the action, all centred. The action never wraps below the text; the
     * text takes the width that is left.
     */
    action?: JSX.Element;
    class?: string;
    bodyClass?: string;
  };

export const NOTICE_CARD_CLASSES = {
  root: "k2b-notice-card",
  icon: "k2b-notice-card__icon",
  content: "k2b-notice-card__content",
  head: "k2b-notice-card__head",
  title: "k2b-notice-card__title",
  meta: "k2b-notice-card__meta",
  description: "k2b-notice-card__description",
  body: "k2b-notice-card__body",
  tile: "k2b-notice-card__tile",
  action: "k2b-notice-card__action",
} as const;

function NoticeCardComponent(props: NoticeCardProps): JSX.Element {
  const [local, articleProps] = splitProps(props, [
    "tone",
    "icon",
    "tile",
    "tileColor",
    "action",
    "title",
    "detail",
    "meta",
    "children",
    "class",
    "bodyClass",
  ]);
  // Children that render nothing, such as a Show whose condition is false, add no body and no gap.
  const body = children(() => local.children);
  const hasBody = () => body.toArray().some((node) => node != null && node !== false && node !== "");
  const messages = useUiMessages();
  /** The tone a dialog also knows, so `icon` true shows the same icon and word; info and neutral have no word. */
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
  return (
    <article
      {...articleProps}
      class={`${NOTICE_CARD_CLASSES.root} ${local.class ?? ""}`}
      data-tone={local.tone ?? "neutral"}
      {...(local.icon ? { "data-icon": "" } : {})}
      {...(local.tile || local.action ? { "data-row": "" } : {})}
    >
      <Show when={local.tile}>
        {(tile) => (
          <span
            class={`${NOTICE_CARD_CLASSES.tile} k2b-icon-tile`}
            style={local.tileColor ? { color: local.tileColor } : undefined}
            aria-hidden="true"
          >
            <i class={tile()} />
          </span>
        )}
      </Show>
      <Show when={icon()}>
        {(icon) => (
          <>
            <i class={`${icon()} ${NOTICE_CARD_CLASSES.icon}`} aria-hidden="true" />
            {/* Inside the icon's branch, so a notice without one keeps its markup. */}
            {toneWord() ? <span class="k2b-sr-only">{toneWord()}</span> : null}
          </>
        )}
      </Show>
      <div class={NOTICE_CARD_CLASSES.content}>
        <Show when={local.title}>
          {(title) => (
            <div class={NOTICE_CARD_CLASSES.head}>
              <p class={NOTICE_CARD_CLASSES.title}>{title()}</p>
              <Show when={local.meta}>{(meta) => <span class={NOTICE_CARD_CLASSES.meta}>{meta()}</span>}</Show>
            </div>
          )}
        </Show>
        <Show when={local.detail}>{(detail) => <p class={NOTICE_CARD_CLASSES.description}>{detail()}</p>}</Show>
        <Show when={hasBody()}>
          <div class={`${NOTICE_CARD_CLASSES.body} ${local.bodyClass ?? ""}`}>{body()}</div>
        </Show>
      </div>
      <Show when={local.action}>{(action) => <div class={NOTICE_CARD_CLASSES.action}>{action()}</div>}</Show>
    </article>
  );
}

export type NoticeGridProps<T> = {
  items: readonly T[];
  children: (item: T) => JSX.Element;
  class?: string;
};

function NoticeGrid<T>(props: NoticeGridProps<T>): JSX.Element {
  const columns = () => (props.items.length <= 1 ? "one" : props.items.length === 2 ? "two" : "three");
  return (
    <Show when={props.items.length > 0}>
      <div class={`k2b-notice-grid ${props.class ?? ""}`} data-columns={columns()}>
        <For each={props.items}>{(item) => props.children(item)}</For>
      </div>
    </Show>
  );
}

export const NoticeCard = Object.assign(NoticeCardComponent, { Grid: NoticeGrid });
export default NoticeCard;
