import { fileIcons } from "@k2b/stdlib";
import type { Token, Tokens } from "marked";
import { createMemo, createSignal, createUniqueId, For, type JSX, onCleanup, Show } from "solid-js";
import { Button, IconButton } from "../actions/Button";
import { copyText } from "../actions/CopyButton";
import { announce } from "../feedback/announce";
import { useLocale } from "../intl/locale";
import { type UiMessages, useUiMessages } from "../intl/messages";
import { Avatar } from "../surfaces/Avatar";
import { createSafeMarked, createSafeRenderer, escapeHtml } from "./MarkdownView";

/** Messages by the same author within this time continue a group. */
const GROUP_WINDOW_MS = 5 * 60_000;
/**
 * A message collapses to ten lines (`.k2b-message-row__text[data-collapsed]`) when its rendered text takes more lines
 * than this. `renderedLines` counts the fewest lines the text takes at any width, so a collapsed message always hides
 * some of it.
 */
const COLLAPSE_LINES = 14;
/** Visible characters that take at least one line of a message, even at its widest. */
const LINE_CHARS = 100;
/** Lines at the bottom of a collapsed message that fade out, as `.k2b-message-row__text[data-collapsed]` draws them. */
const FADE_LINES = 2;
const COPIED_MS = 2_000;
/** Links in messages may only use these schemes; other links show as their text. */
const LINK_PROTOCOLS = ["https:", "http:", "mailto:"] as const;
/** Attachments open and load only from these schemes or from a relative URL; `blob:` covers a file still uploading. */
const ATTACHMENT_PROTOCOLS = new Set(["https:", "http:", "blob:"]);
/** A grid shows this many images or videos; the last one tells how many more there are. */
const MEDIA_SHOWN = 4;
/** A single image keeps its own aspect ratio within these bounds; beyond them it is cropped to fit. */
const MEDIA_RATIO_MIN = 0.5;
const MEDIA_RATIO_MAX = 3;

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

export type MessageRowQuote = {
  /** Name of the quoted message's author. */
  author: string;
  /** Plain text of the quoted message. It shows at most two lines. */
  text: string;
  /** Opens the quoted message, for example by scrolling to it. Without it, the quote is not a control. */
  onSelect?: () => void;
};

export type MessageRowReaction = {
  /** Stable identity of the reaction, passed to `onToggleReaction`. */
  key: string;
  emoji: string;
  count: number;
  /** The reader reacted this way; the chip shows pressed. */
  own?: boolean;
  /** Who reacted, for example "Nora, Tobias". Read by screen readers and shown as a tooltip. */
  label?: string;
};

export type MessageRowThread = {
  /** Number of replies. */
  count: number;
  /** People who replied, most recent first; the bar shows up to three. */
  participants?: readonly MessageRowAuthor[];
  /** Visible time of the last reply, formatted by the caller. */
  lastReply?: string;
  lastReplyDateTime?: string | Date;
  onOpen: () => void;
};

type MessageRowAttachmentTarget = {
  /** Opens the attachment, for example in a lightbox. Takes precedence over `href`. */
  onOpen?: () => void;
  /** Opens the attachment in a new tab. Absolute `https` or `http`, `blob`, or relative. */
  href?: string;
};

export type MessageRowMedia = MessageRowAttachmentTarget & {
  kind: "image" | "video";
  /** The image, or the poster frame of a video. */
  src: string;
  /** Describes the image or video for people who cannot see it. */
  alt: string;
  /** Stored pixel size. The row reserves the area from it, so nothing moves when the image loads. */
  width: number;
  height: number;
  /** Visible length of a video, for example "0:42". */
  duration?: string;
};

export type MessageRowFile = MessageRowAttachmentTarget & {
  kind: "file";
  name: string;
  /** Second line, for example "PDF · 412 KB". */
  detail?: string;
  /** Media type, used with the name to choose the icon. */
  mediaType?: string;
  /** Icon class instead of the one chosen from the name. */
  icon?: string;
};

export type MessageRowAttachment = MessageRowMedia | MessageRowFile;

export type MessageRowProgress = {
  /** What is happening, for example "Writing" or "Searching the files". */
  status: string;
  /** Called by "Stop". */
  onStop?: () => void;
};

export type MessageRowProps = {
  author: MessageRowAuthor;
  /** Message text as Markdown. Raw HTML shows as text; links must be absolute and use `https`, `http`, or `mailto`. */
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
  /** The message this one answers, shown above it. */
  quote?: MessageRowQuote;
  /** Marks the message as forwarded from somewhere else. */
  forwarded?: boolean;
  /** Marks the message as edited after it was sent. */
  edited?: boolean;
  /** Shows "This message was deleted" instead of the text, quote, attachments, previews, and reactions. */
  deleted?: boolean;
  /** Images and videos in a grid with areas reserved from their stored size, then files as chips. */
  attachments?: readonly MessageRowAttachment[];
  /** A preview of a link in the text, supplied with its final height. */
  linkPreview?: JSX.Element;
  /** A card for an element the message refers to, such as a task or a document, supplied with its final height. */
  card?: JSX.Element;
  /**
   * Reactions in a bar of fixed height. The bar shows whenever this is set, even to an empty list, so chips that come
   * and go never change the row. Only setting it where it was unset adds a line; see the docs for where to reserve it.
   */
  reactions?: readonly MessageRowReaction[];
  /** Called with a reaction's `key` when the reader presses its chip. Without it, the chips are not controls. */
  onToggleReaction?: (key: string) => void;
  /** Called by "Add reaction" in the reaction bar, with the button to anchor a picker to. */
  onAddReaction?: (anchor: HTMLElement) => void;
  /** A bar of fixed height that opens the replies to this message. */
  thread?: MessageRowThread;
  /** The message is still being written, by a person or an automated author alike: a status line with "Stop". */
  progress?: MessageRowProgress;
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

/** Text that wraps: every `LINE_CHARS` visible characters of a line take at least one line. */
const wrappedLines = (text: string): number =>
  text.split("\n").reduce((lines, line) => lines + Math.ceil(line.trim().length / LINE_CHARS), 0);

/** What inline tokens show: a link its label, never its destination. */
const inlineText = (tokens: readonly Token[]): string => {
  let text = "";
  for (const token of tokens) {
    if (token.type === "br") text += "\n";
    else if ("tokens" in token && token.tokens) text += inlineText(token.tokens);
    else if ("text" in token) text += token.text;
  }
  return text;
};

/**
 * The fewest lines the rendered tokens take at any width. Code never wraps, so each of its lines is one line, blank
 * ones too, and its bar one more. Link destinations and reference definitions show nothing. Decided from the text
 * alone, so the row has its final height when it mounts.
 */
const renderedLines = (tokens: readonly Token[]): number => {
  let lines = 0;
  for (const token of tokens) {
    switch (token.type) {
      case "code":
        lines += token.text.split("\n").length + 1;
        break;
      case "list":
        for (const item of token.items) lines += Math.max(1, renderedLines(item.tokens));
        break;
      case "table":
        lines += token.rows.length + (token.header.some((cell: Tokens.TableCell) => cell.text.trim()) ? 1 : 0);
        break;
      case "paragraph":
      case "heading":
      case "text":
        lines += wrappedLines(token.tokens ? inlineText(token.tokens) : token.text);
        break;
      case "hr":
        lines += 1;
        break;
      case "space":
      case "def":
        break;
      default:
        if ("tokens" in token && token.tokens) lines += renderedLines(token.tokens);
        else if ("text" in token) lines += wrappedLines(token.text);
    }
  }
  return lines;
};

/** Messages link only to absolute URLs; a relative one would lead somewhere else on every page that shows it. */
const isAbsoluteUrl = (href: string): boolean => {
  try {
    return new URL(href).protocol !== "";
  } catch {
    return false;
  }
};

const dateTimeOf = (value: string | Date | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

/**
 * An attachment URL the row may load or open: absolute with an allowed scheme, or relative to the page. A picture may
 * also be a `data:image/` URL, which an image element shows without running anything.
 */
const attachmentUrl = (url: string | undefined, picture = false): string | undefined => {
  if (!url) return undefined;
  if (picture && /^data:image\//i.test(url)) return url;
  try {
    return ATTACHMENT_PROTOCOLS.has(new URL(url, "https://relative.invalid/").protocol) ? url : undefined;
  } catch {
    return undefined;
  }
};

/** The aspect ratio a single image or video reserves, from its stored size. */
const mediaRatio = (media: MessageRowMedia): number => {
  const ratio = media.width > 0 && media.height > 0 ? media.width / media.height : 4 / 3;
  return Math.min(MEDIA_RATIO_MAX, Math.max(MEDIA_RATIO_MIN, ratio));
};

/** The width of a single image or video: its stored width, at most the row's media height tall, never wider than the row. */
const mediaWidth = (media: MessageRowMedia): string => {
  const natural = Number.isFinite(media.width) && media.width > 0 ? `${media.width}px, ` : "";
  return `min(100%, ${natural}calc(var(--k2b-message-media-height) * ${mediaRatio(media)}))`;
};

/** Only the `ti-*` glyph of `fileIcons`, which may add colour utilities that `@k2b/ui` does not ship. */
const fileIcon = (file: MessageRowFile): string =>
  file.icon ??
  `ti ${fileIcons
    .getFileIcon({ name: file.name, type: "file", mimeType: file.mediaType })
    .split(/\s+/)
    .filter((token) => token.startsWith("ti-"))
    .join(" ")}`;

/** A link, a button, or neither, depending on what the caller passes. */
function AttachmentTarget(
  props: MessageRowAttachmentTarget & {
    class: string;
    style?: JSX.CSSProperties;
    /** Names a picture; without a link or button around it, the element becomes the image. */
    label?: string;
    children: JSX.Element;
  },
): JSX.Element {
  return (
    <Show
      when={props.onOpen}
      fallback={
        <Show
          when={attachmentUrl(props.href)}
          fallback={
            <Show
              when={props.label}
              fallback={
                <span class={props.class} style={props.style}>
                  {props.children}
                </span>
              }
            >
              {(label) => (
                <span class={props.class} style={props.style} role="img" aria-label={label()}>
                  {props.children}
                </span>
              )}
            </Show>
          }
        >
          {(href) => (
            <a class={props.class} style={props.style} href={href()} target="_blank" rel="noopener noreferrer" aria-label={props.label}>
              {props.children}
            </a>
          )}
        </Show>
      }
    >
      {(open) => (
        <button type="button" class={props.class} style={props.style} aria-label={props.label} onClick={() => open()()}>
          {props.children}
        </button>
      )}
    </Show>
  );
}

/**
 * Renders the safe Markdown of `MarkdownView` with line breaks kept, absolute links only, and a copy control above
 * every code block, and counts the fewest lines it takes.
 */
const renderMessage = (text: string, locale: string, messages: UiMessages, edited: boolean): { html: string; lines: number } => {
  const renderer = createSafeRenderer({ allowImages: false, linkProtocols: LINK_PROTOCOLS, linkTarget: "_blank", locale });
  const renderLink = renderer.link.bind(renderer);
  renderer.link = (token: Tokens.Link) => (isAbsoluteUrl(token.href) ? renderLink(token) : renderer.parser.parseInline(token.tokens));
  const renderCode = renderer.code.bind(renderer);
  renderer.code = (token: Tokens.Code) => {
    const language = token.lang?.match(/^\S{1,24}/)?.[0];
    const block = renderCode(token).replace(/^<pre>/, '<pre tabindex="0">');
    return (
      '<div class="k2b-message-row__code"><div class="k2b-message-row__code-bar">' +
      `<span class="k2b-message-row__code-label">${escapeHtml(language ?? messages.code)}</span>` +
      '<button type="button" class="k2b-message-row__copy">' +
      `<span class="k2b-message-row__copy-idle"><i class="ti ti-copy" aria-hidden="true"></i>${escapeHtml(messages.copy)}</span>` +
      `<span class="k2b-message-row__copy-done"><i class="ti ti-check" aria-hidden="true"></i>${escapeHtml(messages.copied)}</span>` +
      `</button></div>${block}</div>`
    );
  };
  const marked = createSafeMarked(locale).setOptions({ breaks: true, renderer });
  const tokens = marked.lexer(text);
  const html = marked.parser(tokens);
  if (!edited) return { html, lines: renderedLines(tokens) };
  // The marker ends the last paragraph, so it takes no line of its own there.
  const marker = `<span class="k2b-message-row__edited">${escapeHtml(messages.messageEdited)}</span>`;
  const end = html.trimEnd();
  return {
    html: end.endsWith("</p>") ? `${end.slice(0, -4)} ${marker}</p>` : `${html}<p>${marker}</p>`,
    lines: renderedLines(tokens),
  };
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
  const rendered = createMemo(() => renderMessage(props.text, locale(), messages(), Boolean(props.edited)));
  const collapsible = () => rendered().lines > COLLAPSE_LINES;
  const collapsed = () => collapsible() && !expanded();
  const groupStart = () => props.groupStart ?? true;
  const hasLine = () => props.progress !== undefined || props.status !== undefined || props.receipt !== undefined;
  const reactions = () => (props.deleted ? undefined : props.reactions);
  const hasFooter = () => hasLine() || reactions() !== undefined;
  const writing = () => props.progress !== undefined && !props.deleted && props.text.trim() === "";
  const hasBubble = () => props.deleted || writing() || props.text.trim() !== "";
  const content = () => !props.deleted;
  const media = createMemo(() =>
    content() ? (props.attachments ?? []).filter((attachment): attachment is MessageRowMedia => attachment.kind !== "file") : [],
  );
  const files = createMemo(() =>
    content() ? (props.attachments ?? []).filter((attachment): attachment is MessageRowFile => attachment.kind === "file") : [],
  );
  const shownMedia = () => media().slice(0, MEDIA_SHOWN);
  const hiddenMedia = () => media().length - shownMedia().length;
  let text: HTMLDivElement | undefined;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => clearTimeout(copiedTimer));

  const copyCode = (event: MouseEvent) => {
    const button = (event.target as Element | null)?.closest?.<HTMLButtonElement>(".k2b-message-row__copy");
    if (!button || !text?.contains(button)) return;
    const code = button.closest(".k2b-message-row__code")?.querySelector("pre")?.textContent ?? "";
    copyText(code).then(
      () => {
        for (const other of text?.querySelectorAll<HTMLElement>(".k2b-message-row__copy[data-copied]") ?? []) delete other.dataset.copied;
        button.dataset.copied = "";
        announce(messages().copied);
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => delete button.dataset.copied, COPIED_MS);
      },
      () => {},
    );
  };

  // A keyboard user who reaches a link or code block in the hidden or faded part of a collapsed message gets the whole
  // message. The collapsed text clips instead of scrolling, so the browser cannot scroll it to the target instead.
  const revealFocus = (event: FocusEvent) => {
    if (!text || !collapsed() || !(event.target instanceof Element)) return;
    const fade = text.getBoundingClientRect().bottom - FADE_LINES * Number.parseFloat(getComputedStyle(text).lineHeight);
    if (event.target.getBoundingClientRect().bottom > fade) setExpanded(true);
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

  const quote = (value: MessageRowQuote) => (
    <>
      <i class="ti ti-arrow-back-up" aria-hidden="true" />
      <span class="k2b-message-row__quote-text">
        <span class="k2b-sr-only">{messages().messageReplyTo} </span>
        <span class="k2b-message-row__quote-author">{value.author}</span> {value.text}
      </span>
    </>
  );

  /** The picture's description, then that it is a video and how long, then how many more the grid hides. */
  const mediaLabel = (item: MessageRowMedia, more: number) =>
    [
      item.alt,
      item.kind === "video" ? [messages().messageVideo, item.duration].filter(Boolean).join(" ") : "",
      more > 0 ? messages().messageMoreAttachments({ count: more }) : "",
    ]
      .filter(Boolean)
      .join(", ");

  const mediaItem = (item: MessageRowMedia, index: () => number) => {
    const more = () => (index() === shownMedia().length - 1 ? hiddenMedia() : 0);
    return (
      <AttachmentTarget
        class="k2b-message-row__media-item"
        style={media().length === 1 ? { "aspect-ratio": String(mediaRatio(item)) } : undefined}
        label={mediaLabel(item, more())}
        onOpen={item.onOpen}
        href={item.href}
      >
        <img
          src={attachmentUrl(item.src, true)}
          alt=""
          width={item.width > 0 ? item.width : undefined}
          height={item.height > 0 ? item.height : undefined}
          loading="lazy"
          decoding="async"
        />
        <Show when={item.kind === "video"}>
          <span class="k2b-message-row__media-play" aria-hidden="true">
            <i class="ti ti-player-play" />
          </span>
          <Show when={item.duration}>
            <span class="k2b-message-row__media-duration" aria-hidden="true">
              {item.duration}
            </span>
          </Show>
        </Show>
        <Show when={more() > 0}>
          <span class="k2b-message-row__media-more" aria-hidden="true">
            +{more()}
          </span>
        </Show>
      </AttachmentTarget>
    );
  };

  return (
    <div
      class={props.class ? `k2b-message-row ${props.class}` : "k2b-message-row"}
      data-own={props.own ? "" : undefined}
      data-group-start={groupStart() ? "" : undefined}
      data-status={props.status}
      data-media={media().length > 0 ? "" : undefined}
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
        <Show when={content() && props.forwarded}>
          <div class="k2b-message-row__marker">
            <i class="ti ti-arrow-forward-up" aria-hidden="true" />
            <span>{messages().messageForwarded}</span>
          </div>
        </Show>
        <Show when={content() && props.quote}>
          {(value) => (
            <Show when={value().onSelect} fallback={<div class="k2b-message-row__quote">{quote(value())}</div>}>
              {(select) => (
                <button type="button" class="k2b-message-row__quote" onClick={() => select()()}>
                  {quote(value())}
                </button>
              )}
            </Show>
          )}
        </Show>
        <Show when={hasBubble()}>
          <div class="k2b-message-row__bubble" data-deleted={props.deleted ? "" : undefined}>
            <Show
              when={!props.deleted}
              fallback={
                <span class="k2b-message-row__deleted">
                  <i class="ti ti-message-off" aria-hidden="true" />
                  {messages().messageDeleted}
                </span>
              }
            >
              <Show
                when={!writing()}
                fallback={
                  <span class="k2b-message-row__writing">
                    <span class="k2b-chat-progress-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                  </span>
                }
              >
                {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the native copy buttons inside the rendered Markdown are the targets; their clicks, including from the keyboard, bubble here. */}
                <div
                  ref={text}
                  id={textId}
                  class="k2b-content-markdown k2b-message-row__text"
                  data-heading-scale="compact"
                  data-collapsed={collapsed() ? "" : undefined}
                  aria-busy={props.progress ? "true" : undefined}
                  onClick={copyCode}
                  onFocusIn={revealFocus}
                  innerHTML={rendered().html}
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
              </Show>
            </Show>
          </div>
        </Show>
        <Show when={media().length > 0}>
          <div
            class="k2b-message-row__media"
            role="group"
            aria-label={messages().attachments}
            data-count={Math.min(media().length, MEDIA_SHOWN)}
            style={media().length === 1 ? { width: mediaWidth(media()[0]!) } : undefined}
          >
            <For each={shownMedia()}>{(item, index) => mediaItem(item, index)}</For>
          </div>
        </Show>
        <Show when={files().length > 0}>
          <div class="k2b-message-row__files">
            <For each={files()}>
              {(file) => (
                <AttachmentTarget class="k2b-message-row__file" onOpen={file.onOpen} href={file.href}>
                  <span class="k2b-message-row__file-icon" aria-hidden="true">
                    <i class={fileIcon(file)} />
                  </span>
                  <span class="k2b-message-row__file-copy">
                    <span class="k2b-message-row__file-name">{file.name}</span>
                    <Show when={file.detail}>
                      <span class="k2b-message-row__file-detail">{file.detail}</span>
                    </Show>
                  </span>
                </AttachmentTarget>
              )}
            </For>
          </div>
        </Show>
        <Show when={content() && props.linkPreview}>
          <div class="k2b-message-row__slot">{props.linkPreview}</div>
        </Show>
        <Show when={content() && props.card}>
          <div class="k2b-message-row__slot">{props.card}</div>
        </Show>
        <Show when={props.thread}>
          {(thread) => (
            <button type="button" class="k2b-message-row__thread" onClick={() => thread().onOpen()}>
              <Show when={(thread().participants?.length ?? 0) > 0}>
                <span class="k2b-message-row__thread-people" aria-hidden="true">
                  <For each={thread().participants?.slice(0, 3)}>
                    {(person) => <Avatar name={person.name} src={person.avatar} icon={person.icon} size="xs" />}
                  </For>
                </span>
              </Show>
              <span class="k2b-message-row__thread-count">{messages().messageReplies({ count: thread().count })}</span>
              <Show when={thread().lastReply}>
                {(time) => (
                  <time class="k2b-message-row__thread-time" datetime={dateTimeOf(thread().lastReplyDateTime)}>
                    {messages().messageLastReply({ time: time() })}
                  </time>
                )}
              </Show>
            </button>
          )}
        </Show>
        <Show when={hasFooter()}>
          <div class="k2b-message-row__footer">
            <Show when={reactions()}>
              {(list) => (
                <div
                  class="k2b-message-row__reactions"
                  role="group"
                  aria-label={messages().messageReactions}
                  data-empty={list().length === 0 ? "" : undefined}
                >
                  <Show when={list().length > 0}>
                    <div class="k2b-message-row__reaction-list">
                      <For each={list()}>
                        {(reaction) => {
                          const label = () =>
                            messages().messageReaction({ emoji: reaction.emoji, count: reaction.count, names: reaction.label });
                          return (
                            <Show
                              when={props.onToggleReaction}
                              fallback={
                                <span
                                  class="k2b-message-row__reaction"
                                  role="img"
                                  aria-label={label()}
                                  title={reaction.label}
                                  data-own={reaction.own ? "" : undefined}
                                >
                                  <span aria-hidden="true">{reaction.emoji}</span>
                                  <span aria-hidden="true">{reaction.count}</span>
                                </span>
                              }
                            >
                              {(toggle) => (
                                <button
                                  type="button"
                                  class="k2b-message-row__reaction"
                                  aria-pressed={reaction.own ? "true" : "false"}
                                  aria-label={label()}
                                  title={reaction.label}
                                  data-own={reaction.own ? "" : undefined}
                                  onClick={() => toggle()(reaction.key)}
                                >
                                  <span aria-hidden="true">{reaction.emoji}</span>
                                  <span aria-hidden="true">{reaction.count}</span>
                                </button>
                              )}
                            </Show>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                  <Show when={props.onAddReaction}>
                    {(add) => (
                      <IconButton
                        label={messages().messageAddReaction}
                        size="xs"
                        class="k2b-message-row__react"
                        onClick={(event) => add()(event.currentTarget)}
                      >
                        <i class="ti ti-mood-plus" aria-hidden="true" />
                      </IconButton>
                    )}
                  </Show>
                </div>
              )}
            </Show>
            <Show when={hasLine()}>
              <div class="k2b-message-row__line">
                <Show
                  when={props.progress}
                  fallback={
                    <>
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
                    </>
                  }
                >
                  {(progress) => (
                    <>
                      <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
                      <span class="k2b-message-row__line-text">{progress().status}</span>
                      <Show when={progress().onStop}>
                        {(stop) => (
                          <Button variant="text" size="xs" onClick={() => stop()()}>
                            {messages().messageStop}
                          </Button>
                        )}
                      </Show>
                    </>
                  )}
                </Show>
              </div>
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
