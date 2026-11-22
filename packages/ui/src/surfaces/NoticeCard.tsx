import { children, For, type JSX, Show, splitProps } from "solid-js";
import { dialogToneIcon, dialogToneLabel } from "../feedback/dialog-tone";
import { rendersSomething } from "../internal/renders-something";
import { useUiMessages } from "../intl/messages";
import type { IntentTone } from "../semantics";

/** `yours` is "your turn" (Valentin, 21.11.): a blue tint where the reader has to act; `warning` stays "to clarify". */
export type NoticeTone = Extract<IntentTone, "neutral" | "info" | "success" | "warning" | "danger"> | "ai" | "yours";

type NoticeCardContentProps =
  | { title: JSX.Element; detail?: JSX.Element; meta?: JSX.Element; children?: JSX.Element }
  | { title?: never; detail?: never; meta?: never; children: JSX.Element };

export type NoticeCardProps = Omit<JSX.HTMLAttributes<HTMLElement>, "children" | "class" | "title"> &
  NoticeCardContentProps & {
    tone?: NoticeTone;
    /**
     * A Tabler icon class. By default it turns the notice into a compact status line whose icon and text take the tone
     * colour; `layout="card"` keeps the card instead. `true`
     * takes the tone's own icon, the one a toned dialog shows, and names the tone for screen readers.
     */
    icon?: string | true;
    /**
     * Where an icon goes. `line`, the default, is the compact status line above. `card` keeps the calm card and sets the
     * icon in the tone colour beside the title, text, and actions, which share one text edge.
     */
    layout?: "line" | "card";
    /**
     * The deed: one `Button` or `ButtonLink` (`size="sm"`, `secondary`) whose words name what it does, never "Try
     * again" (K10). A wide notice sets it beside the text, a narrow one below it. A second button is possible but
     * rare. In a `NoticeCard.Grid` row the actions of all cards share the bottom edge.
     */
    actions?: JSX.Element;
    class?: string;
    bodyClass?: string;
  };

export const NOTICE_CARD_CLASSES = {
  root: "k2b-notice-card",
  icon: "k2b-notice-card__icon",
  content: "k2b-notice-card__content",
  text: "k2b-notice-card__text",
  head: "k2b-notice-card__head",
  title: "k2b-notice-card__title",
  meta: "k2b-notice-card__meta",
  description: "k2b-notice-card__description",
  body: "k2b-notice-card__body",
  actions: "k2b-notice-card__actions",
} as const;

function NoticeCardComponent(props: NoticeCardProps): JSX.Element {
  const [local, articleProps] = splitProps(props, [
    "tone",
    "icon",
    "layout",
    "title",
    "detail",
    "meta",
    "children",
    "actions",
    "class",
    "bodyClass",
  ]);
  // Children that render nothing, such as a Show whose condition is false, add no body and no gap.
  const body = children(() => local.children);
  const hasBody = () => rendersSomething(body.toArray());
  const actions = children(() => local.actions);
  const hasActions = () => rendersSomething(actions.toArray());
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
      // An alert cell is a band (K10): its tint runs from edge to edge of its column; it holds its own text edge.
      data-k2b-band="cell"
      {...(local.icon ? { [local.layout === "card" ? "data-card-icon" : "data-icon"]: "" } : {})}
      // A spread, not `data-actions={… : undefined}`: SSR writes an absent attribute as a stray space before `>`.
      {...(hasActions() ? { "data-actions": "" } : {})}
    >
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
        {/* The sentence and its consequence share one block, so a wide cell sets the deed beside it and a narrow
            one below it (K10, K15). */}
        <div class={NOTICE_CARD_CLASSES.text}>
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
        <Show when={hasActions()}>
          <div class={NOTICE_CARD_CLASSES.actions}>{actions()}</div>
        </Show>
      </div>
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
