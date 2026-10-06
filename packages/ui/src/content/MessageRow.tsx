import type { Tokens } from "marked";
import { createEffect, createSignal, createUniqueId, For, type JSX, on, onCleanup, Show } from "solid-js";
import { Button, IconButton } from "../actions/Button";
import { copyText } from "../actions/CopyButton";
import { announce } from "../feedback/announce";
import { useLocale } from "../intl/locale";
import { type UiMessages, useUiMessages } from "../intl/messages";
import { Avatar } from "../surfaces/Avatar";
import { createSafeRenderer, escapeHtml, renderSafeMarkdownWith } from "./MarkdownView";

/** Messages by the same author within this time continue a group. */
const GROUP_WINDOW_MS = 5 * 60_000;
/**
 * A message collapses to ten lines (`.k2b-message-row__text[data-collapsed]`) when its source has more lines than
 * this. A line of the source is at least one line on screen, and every `LINE_CHARS` characters are at least one
 * more, so a collapsed message always hides some text.
 */
const COLLAPSE_LINES = 14;
const LINE_CHARS = 100;
const COPIED_MS = 2_000;
/** Links in messages may only use these schemes; other links show as their text. */
const LINK_PROTOCOLS = ["https:", "http:", "mailto:"] as const;

export type MessageRowAuthor = {
  /** Display name, shown at the start of a group and read before every message. */
  name: string;
  /** Picture URL. Without one, the avatar shows initials on the author's tint. */
  avatar?: string | null;
  /** Icon class shown instead of initials, for example for an automated author. */
  icon?: string;
};

export type MessageRowStatus = "pending" | "sent" | "failed";

export type MessageRowAction = {
  id: string;
  /** Accessible name and tooltip. */
  label: string;
  /** Icon class, for example `ti ti-arrow-back-up`. */
  icon: string;
  onSelect: () => void;
  disabled?: boolean;
};

export type MessageRowProps = {
  author: MessageRowAuthor;
  /** Message text as Markdown. Raw HTML shows as text; links may use `https`, `http`, or `mailto`. */
  text: string;
  /** Visible time, formatted by the caller, so server and browser render the same text. */
  time: string;
  /** Machine-readable time for the `<time>` element. */
  dateTime?: string | Date;
  /** The reader's own message: on the right in the accent tint, without avatar or name. */
  own?: boolean;
  /**
   * Starts a group with avatar, name, badge, and time. A continuation shows only its text; screen readers still hear
   * the author and time. Defaults to true; `startsMessageGroup` decides it from the previous message.
   */
  groupStart?: boolean;
  /** Shown next to the name at the start of a group, for example the kind of account. */
  badge?: JSX.Element;
  /** Send state. Sets a line of fixed height below the message: a clock, a check, or "Not sent" with "Retry". */
  status?: MessageRowStatus;
  /** Text shown in that line instead of the check once someone has read the message, for example "Read by Nora". */
  receipt?: string;
  /** Called by "Retry" while `status` is `"failed"`. */
  onRetry?: () => void;
  /** Shown as a toolbar over the message while it is hovered or focused. It never moves the layout. */
  actions?: readonly MessageRowAction[];
  class?: string;
};

export type MessageSystemRowProps = {
  /** What happened, for example "Nora added Tobias". */
  children: JSX.Element;
  /** Visible time, formatted by the caller. */
  time?: string;
  dateTime?: string | Date;
  /** Icon class shown before the text. */
  icon?: string;
  class?: string;
};

export type MessageGroupEntry = {
  /** Stable identity of the author. */
  author: string;
  at: Date | number | string;
  /** System rows never belong to a group. */
  system?: boolean;
};

const timestamp = (value: Date | number | string) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

/**
 * Whether a message starts a new group: there is no previous message, either is a system row, the author changes, or
 * more than five minutes passed. Also start a group where you show a separator such as a new day.
 */
export const startsMessageGroup = (entry: MessageGroupEntry, previous?: MessageGroupEntry | null): boolean => {
  if (!previous || entry.system || previous.system || entry.author !== previous.author) return true;
  const gap = timestamp(entry.at) - timestamp(previous.at);
  return !(gap >= 0 && gap <= GROUP_WINDOW_MS);
};

/** Decided from the text alone, so the row has its final height when it mounts. */
const collapses = (text: string): boolean => {
  let lines = 0;
  for (const line of text.split("\n")) {
    const length = line.trim().length;
    if (length > 0) lines += Math.ceil(length / LINE_CHARS);
    if (lines > COLLAPSE_LINES) return true;
  }
  return false;
};

const dateTimeOf = (value: string | Date | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

/** The safe Markdown of `MarkdownView` with line breaks kept and a copy control above every code block. */
const renderMessage = (text: string, locale: string, messages: UiMessages): string => {
  const renderer = createSafeRenderer({ allowImages: false, linkProtocols: LINK_PROTOCOLS, linkTarget: "_blank", locale });
  const renderCode = renderer.code.bind(renderer);
  renderer.code = (token: Tokens.Code) => {
    const language = token.lang?.match(/^\S{1,24}/)?.[0];
    const block = renderCode(token).replace(/^<pre>/, '<pre tabindex="0">');
    return (
      '<div class="k2b-message-row__code"><div class="k2b-message-row__code-bar">' +
      `<span>${escapeHtml(language ?? messages.code)}</span>` +
      '<button type="button" class="k2b-message-row__copy">' +
      `<span class="k2b-message-row__copy-idle"><i class="ti ti-copy" aria-hidden="true"></i>${escapeHtml(messages.copy)}</span>` +
      `<span class="k2b-message-row__copy-done"><i class="ti ti-check" aria-hidden="true"></i>${escapeHtml(messages.copied)}</span>` +
      `</button></div>${block}</div>`
    );
  };
  return renderSafeMarkdownWith(text, { locale }, renderer, true);
};

/**
 * One message in a conversation with many people: own messages on the right, others on the left with avatar, name,
 * and time at the start of a group. Every part has its final height when the row mounts, so a virtualized list such
 * as `VirtualFeed` keeps its positions.
 */
export function MessageRow(props: MessageRowProps): JSX.Element {
  const messages = useUiMessages();
  const locale = useLocale();
  const textId = `k2b-message-${createUniqueId()}`;
  const [expanded, setExpanded] = createSignal(false);
  const collapsible = () => collapses(props.text);
  const collapsed = () => collapsible() && !expanded();
  const groupStart = () => props.groupStart ?? true;
  const hasLine = () => props.status !== undefined || props.receipt !== undefined;
  let text!: HTMLDivElement;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => clearTimeout(copiedTimer));

  // A send that fails after the row is shown is said out loud; the line only shows it.
  createEffect(
    on(
      () => props.status,
      (status, previous) => {
        if (status === "failed" && previous !== "failed") announce(messages().messageNotSent);
      },
      { defer: true },
    ),
  );

  const copyCode = (event: MouseEvent) => {
    const button = (event.target as Element | null)?.closest?.<HTMLButtonElement>(".k2b-message-row__copy");
    if (!button || !text.contains(button)) return;
    const code = button.closest(".k2b-message-row__code")?.querySelector("pre")?.textContent ?? "";
    copyText(code).then(
      () => {
        for (const other of text.querySelectorAll<HTMLElement>(".k2b-message-row__copy[data-copied]")) delete other.dataset.copied;
        button.dataset.copied = "";
        announce(messages().copied);
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => delete button.dataset.copied, COPIED_MS);
      },
      () => {},
    );
  };

  // A keyboard user tabbing to a link hidden below the fold of a collapsed message gets the whole message.
  const revealFocus = (event: FocusEvent) => {
    if (!collapsed()) return;
    const target = event.target as HTMLElement;
    if (target.getBoundingClientRect().bottom > text.getBoundingClientRect().bottom) setExpanded(true);
  };

  const header = () => (
    <>
      <span class="k2b-message-row__name">{props.author.name}</span>
      <Show when={props.badge}>
        <span class="k2b-message-row__badge">{props.badge}</span>
      </Show>
      <time class="k2b-message-row__time" datetime={dateTimeOf(props.dateTime)}>
        {props.time}
      </time>
    </>
  );

  return (
    <div
      class={props.class ? `k2b-message-row ${props.class}` : "k2b-message-row"}
      data-own={props.own ? "" : undefined}
      data-group-start={groupStart() ? "" : undefined}
      data-status={props.status}
    >
      <Show when={!props.own}>
        <div class="k2b-message-row__gutter">
          <Show when={groupStart()}>
            <span class="k2b-message-row__avatar" aria-hidden="true">
              <Avatar name={props.author.name} src={props.author.avatar} icon={props.author.icon} size="sm" />
            </span>
          </Show>
        </div>
      </Show>
      <div class="k2b-message-row__body">
        <Show
          when={groupStart()}
          fallback={
            <span class="k2b-sr-only">
              {props.author.name}, {props.time}:{" "}
            </span>
          }
        >
          <Show
            when={!props.own}
            fallback={
              <div class="k2b-message-row__meta">
                <span class="k2b-sr-only">{props.author.name}, </span>
                <time class="k2b-message-row__time" datetime={dateTimeOf(props.dateTime)}>
                  {props.time}
                </time>
              </div>
            }
          >
            <div class="k2b-message-row__meta">{header()}</div>
          </Show>
        </Show>
        <div class="k2b-message-row__bubble">
          {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the native copy buttons inside the rendered Markdown are the targets; their clicks, including from the keyboard, bubble here. */}
          <div
            ref={text}
            id={textId}
            class="k2b-content-markdown k2b-message-row__text"
            data-heading-scale="compact"
            data-collapsed={collapsed() ? "" : undefined}
            onClick={copyCode}
            onFocusIn={revealFocus}
            innerHTML={renderMessage(props.text, locale(), messages())}
          />
          <Show when={collapsible()}>
            <Button
              variant="text"
              size="xs"
              class="k2b-message-row__more"
              aria-expanded={expanded() ? "true" : "false"}
              aria-controls={textId}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded() ? messages().messageShowLess : messages().messageShowMore}
            </Button>
          </Show>
        </div>
        <Show when={hasLine()}>
          <div class="k2b-message-row__line">
            <Show when={props.status === "pending"}>
              <i class="ti ti-clock" aria-hidden="true" />
              <span>{messages().sending}</span>
            </Show>
            <Show when={props.status === "failed"}>
              <i class="ti ti-alert-circle" aria-hidden="true" />
              <span>{messages().messageNotSent}</span>
              <Show when={props.onRetry}>
                {(retry) => (
                  <Button variant="text" size="xs" onClick={() => retry()()}>
                    {messages().messageRetry}
                  </Button>
                )}
              </Show>
            </Show>
            <Show when={props.status !== "pending" && props.status !== "failed"}>
              <Show
                when={props.receipt}
                fallback={
                  <Show when={props.status === "sent"}>
                    <i class="ti ti-check" aria-hidden="true" />
                    <span class="k2b-sr-only">{messages().messageSent}</span>
                  </Show>
                }
              >
                {(receipt) => (
                  <>
                    <i class="ti ti-checks" aria-hidden="true" />
                    <span class="k2b-message-row__receipt">{receipt()}</span>
                  </>
                )}
              </Show>
            </Show>
          </div>
        </Show>
      </div>
      <Show when={(props.actions?.length ?? 0) > 0}>
        <div class="k2b-message-row__actions" role="group" aria-label={messages().messageActions}>
          <For each={props.actions}>
            {(action) => (
              <IconButton label={action.label} size="sm" disabled={action.disabled} onClick={() => action.onSelect()}>
                <i class={action.icon} aria-hidden="true" />
              </IconButton>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** A quiet, centered line for something that happened in the conversation, such as a person joining. */
export function MessageSystemRow(props: MessageSystemRowProps): JSX.Element {
  return (
    <div class={props.class ? `k2b-message-system-row ${props.class}` : "k2b-message-system-row"}>
      <Show when={props.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
      <span>{props.children}</span>
      <Show when={props.time}>
        <time datetime={dateTimeOf(props.dateTime)}>{props.time}</time>
      </Show>
    </div>
  );
}
