import { For, type JSX, Show, splitProps } from "solid-js";
import type { IntentTone } from "../semantics";

export type NoticeTone = Extract<IntentTone, "neutral" | "info" | "success" | "warning" | "danger">;

type NoticeCardContentProps =
  | { title: JSX.Element; detail?: JSX.Element; meta?: JSX.Element; children?: JSX.Element }
  | { title?: never; detail?: never; meta?: never; children: JSX.Element };

export type NoticeCardProps = Omit<JSX.HTMLAttributes<HTMLElement>, "children" | "class" | "title"> &
  NoticeCardContentProps & {
    tone?: NoticeTone;
    class?: string;
    bodyClass?: string;
  };

export const NOTICE_CARD_CLASSES = {
  root: "k2b-notice-card",
  content: "k2b-notice-card__content",
  head: "k2b-notice-card__head",
  title: "k2b-notice-card__title",
  meta: "k2b-notice-card__meta",
  description: "k2b-notice-card__description",
  body: "k2b-notice-card__body",
} as const;

function NoticeCardComponent(props: NoticeCardProps): JSX.Element {
  const [local, articleProps] = splitProps(props, ["tone", "title", "detail", "meta", "children", "class", "bodyClass"]);
  return (
    <article {...articleProps} class={`${NOTICE_CARD_CLASSES.root} ${local.class ?? ""}`} data-tone={local.tone ?? "neutral"}>
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
        <Show when={local.children}>{(body) => <div class={`${NOTICE_CARD_CLASSES.body} ${local.bodyClass ?? ""}`}>{body()}</div>}</Show>
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
