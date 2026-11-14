import { For, type JSX, Show } from "solid-js";
import { Button } from "../actions/Button";
import { CopyButton } from "../actions/CopyButton";
import { useUiMessages } from "../intl/messages";
import { Avatar } from "../surfaces/Avatar";
import { Skeleton } from "../surfaces/Skeleton";
import { AnchoredPopover } from "./AnchoredPopover";

export type PersonPopoverPhone = { number: string /** Such as "Office" or "Mobile". */; label?: string };

/** A row of the list section, such as an earlier conversation: a link or a button. */
export type PersonPopoverLink = {
  label: string /** A quiet second line, such as a date and a count. */;
  meta?: string;
  href?: string;
  onSelect?: () => void;
};

/** A menu-like row at the end of the card. Choosing it closes the card. */
export type PersonPopoverAction = { label: string; icon?: string; href?: string; onSelect?: () => void; disabled?: boolean };

/** A quiet line in place of what could not load, with a retry. */
export type PersonPopoverError = { message: string; onRetry: () => void /** Defaults to the shared "Retry". */; retryLabel?: string };

export type PersonPopoverList = {
  title: string;
  items?: readonly PersonPopoverLink[];
  /** Two placeholder rows in the size of real rows while the list loads. */
  loading?: boolean;
  error?: PersonPopoverError;
  /** A quiet line when the list is empty; without it an empty list hides the section. */
  empty?: string;
};

export type PersonPopoverProps = {
  /** The control the card belongs to, such as a sender name. The card is open while this is set. */
  anchor: HTMLElement | null | undefined;
  onClose: () => void;
  /** The card's accessible name; defaults to the name or the address. */
  label?: string;
  /** The person's name. Without it the address heads the card. */
  name?: string;
  /** An image URL for the avatar; without it the avatar shows initials. */
  avatar?: string | null;
  /** One secondary line, such as company and role. */
  detail?: string;
  /** Shown with a copy button. */
  email?: string;
  /** Each number is a `tel:` link with an optional label. */
  phones?: readonly PersonPopoverPhone[];
  /** While the person's details load, placeholders stand where the detail line and the contact rows will be. */
  loading?: boolean;
  /** The details could not load: a quiet line with a retry stands in their place. */
  error?: PersonPopoverError;
  /** An optional section with a heading and link rows, such as earlier conversations. */
  list?: PersonPopoverList;
  actions?: readonly PersonPopoverAction[];
  align?: "start" | "end";
  side?: "below" | "above";
  /** Desktop width, such as `22rem`. On a phone the card is a bottom sheet. */
  width?: string;
  class?: string;
};

const focusable = "a[href],button:not(:disabled)";

/**
 * A card about one person, anchored to the control that names them: avatar, name, one secondary line, contact rows,
 * an optional list such as earlier conversations, and actions. The application supplies every text and decides what
 * the actions do; the card owns layout, loading, partial and error states, and keyboard behaviour.
 */
export function PersonPopover(props: PersonPopoverProps): JSX.Element {
  const messages = useUiMessages();
  let content: HTMLDivElement | undefined;
  const heading = () => props.name || props.email || "";
  const done = () => props.onClose();
  const choose = (onSelect: (() => void) | undefined) => {
    onSelect?.();
    done();
  };
  const arrows = (event: KeyboardEvent & { currentTarget: HTMLElement }) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const stops = [...event.currentTarget.querySelectorAll<HTMLElement>(focusable)];
    if (stops.length === 0) return;
    const index = stops.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (index + 1) % stops.length : index <= 0 ? stops.length - 1 : index - 1;
    stops[next]?.focus();
    event.preventDefault();
  };
  const errorLine = (error: PersonPopoverError) => (
    <p class="k2b-person-popover__error">
      <span>{error.message}</span>
      <Button variant="ghost" size="sm" onClick={() => error.onRetry()}>
        {error.retryLabel ?? messages().retry}
      </Button>
    </p>
  );
  const row = (
    item: { label: string; href?: string; onSelect?: () => void; disabled?: boolean },
    content: JSX.Element,
    className: string,
  ) =>
    item.href && !item.disabled ? (
      <a class={className} href={item.href} onClick={() => choose(item.onSelect)}>
        {content}
      </a>
    ) : (
      <button type="button" class={className} disabled={item.disabled} onClick={() => choose(item.onSelect)}>
        {content}
      </button>
    );

  return (
    <AnchoredPopover
      anchor={props.anchor}
      onClose={props.onClose}
      label={props.label ?? heading()}
      align={props.align ?? "start"}
      side={props.side}
      width={props.width}
      initialFocus={() => content}
      class={props.class}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys from the card's own links and buttons bubble here to move between them. */}
      <div ref={content} class="k2b-person-popover__content" tabIndex={-1} onKeyDown={arrows}>
        <span class="k2b-sr-only" role="status">
          {props.loading || props.list?.loading ? messages().loading : ""}
        </span>
        <div class="k2b-person-popover__head">
          <Avatar name={heading()} src={props.avatar} size="md" />
          <div class="k2b-person-popover__identity">
            <div class="k2b-person-popover__title">
              <h2 class="k2b-person-popover__name">{heading()}</h2>
              <Show when={!props.name && props.email}>{(email) => <CopyButton text={email()} size="xs" />}</Show>
            </div>
            <Show
              when={props.loading}
              fallback={<Show when={props.detail}>{(detail) => <p class="k2b-person-popover__detail">{detail()}</p>}</Show>}
            >
              <Skeleton class="k2b-person-popover__line" />
            </Show>
          </div>
        </div>
        <Show
          when={!props.loading}
          fallback={
            <div class="k2b-person-popover__contacts" aria-hidden="true">
              <Skeleton class="k2b-person-popover__contact-placeholder" />
              <Skeleton class="k2b-person-popover__contact-placeholder" />
            </div>
          }
        >
          <Show when={!props.error} fallback={errorLine(props.error!)}>
            <Show when={(props.name && props.email) || props.phones?.length}>
              <ul class="k2b-person-popover__contacts">
                <Show when={props.name ? props.email : undefined}>
                  {(email) => (
                    <li class="k2b-person-popover__contact">
                      <i class="ti ti-mail" aria-hidden="true" />
                      <span class="k2b-person-popover__value">{email()}</span>
                      <CopyButton text={email()} size="xs" />
                    </li>
                  )}
                </Show>
                <For each={props.phones}>
                  {(phone) => (
                    <li class="k2b-person-popover__contact">
                      <i class="ti ti-phone" aria-hidden="true" />
                      <a class="k2b-person-popover__value" href={`tel:${phone.number.replace(/[^\d+]/g, "")}`}>
                        {phone.number}
                      </a>
                      <Show when={phone.label}>{(label) => <span class="k2b-person-popover__meta">{label()}</span>}</Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
        <Show
          when={
            props.list && (props.list.loading || props.list.error || props.list.items?.length || props.list.empty) ? props.list : undefined
          }
        >
          {(list) => (
            <section class="k2b-person-popover__list">
              <h3 class="k2b-person-popover__list-title">{list().title}</h3>
              <Show
                when={!list().loading}
                fallback={
                  <div class="k2b-person-popover__placeholders" aria-hidden="true">
                    <Skeleton class="k2b-person-popover__link-placeholder" />
                    <Skeleton class="k2b-person-popover__link-placeholder" />
                  </div>
                }
              >
                <Show when={!list().error} fallback={errorLine(list().error!)}>
                  <Show when={list().items?.length} fallback={<p class="k2b-person-popover__empty">{list().empty}</p>}>
                    <ul>
                      <For each={list().items}>
                        {(item) => (
                          <li>
                            {row(
                              item,
                              <>
                                <span class="k2b-person-popover__link-label">{item.label}</span>
                                <Show when={item.meta}>{(meta) => <span class="k2b-person-popover__meta">{meta()}</span>}</Show>
                              </>,
                              "k2b-person-popover__link",
                            )}
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </Show>
              </Show>
            </section>
          )}
        </Show>
        <Show when={props.actions?.length}>
          <ul class="k2b-person-popover__actions">
            <For each={props.actions}>
              {(action) => (
                <li>
                  {row(
                    action,
                    <>
                      <i class={action.icon ?? ""} aria-hidden="true" />
                      <span>{action.label}</span>
                    </>,
                    "k2b-person-popover__action",
                  )}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </AnchoredPopover>
  );
}
