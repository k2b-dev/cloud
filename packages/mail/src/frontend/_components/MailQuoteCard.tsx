import { Avatar, Button, IconButton, Skeleton, useLocale } from "@k2b/ui";
import { createSignal, createUniqueId, Match, Show, Switch } from "solid-js";
import { mailComposerMessages } from "./mail-composer-messages";

/** The message a reply quotes, as the card shows it: who wrote it when, and the text that goes along. */
export type MailQuoteOriginal = { name: string; date: string; text: string };
export type MailQuoteOriginalState =
  | { status: "loading" }
  | { status: "failed" }
  /** Gone or not visible to this person: the send renderer adds no quote, so no card stands. */
  | { status: "missing" }
  | { status: "ready"; original: MailQuoteOriginal };

/** Paragraphs as the sent mail shows them: blank lines part them. */
const paragraphs = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
const lines = (text: string) => text.split("\n").filter((line) => line.trim());
/** The first two lines with content: a greeting alone ("Hello,") says nothing about the message. */
const firstLines = (text: string) => {
  const all = lines(text);
  const start = Math.max(
    0,
    all.findIndex((line) => line.trim().split(/\s+/).length > 3),
  );
  return all.slice(start, start + 2);
};

/**
 * Whether the collapsed card hides anything: lines below the first two, a greeting above them, or a line too long to
 * stand on one line on a phone.
 */
const hidesText = (text: string) => {
  const shown = firstLines(text);
  return shown.join("\n") !== lines(text).join("\n") || shown.some((line) => line.length > 60);
};

/** Whether a message has text that goes along as a quote; without it the send renderer adds none. */
export const hasQuotableText = (text: string) => text.trim().length > 0;

/**
 * The original message under the signature, where the sent mail puts it: avatar, name, date, its first two lines with
 * the quote line of the sent mail, "Show all", and × to leave it out. Left out, one quiet line at the same place adds it
 * again. Loading keeps the collapsed card's height, so nothing moves when the message arrives.
 */
export function MailQuoteCard(props: {
  state: MailQuoteOriginalState;
  quoting: boolean;
  disabled: boolean;
  onRemove: () => void;
  onAdd: () => void;
  onRetry: () => void;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const [open, setOpen] = createSignal(false);
  const textId = createUniqueId();
  /** × and "add" swap places; the focus follows to the control that takes the place, never to the page. */
  let focusNext: "add" | "remove" | null = null;
  const remove = () => {
    focusNext = "add";
    props.onRemove();
  };
  const add = () => {
    focusNext = "remove";
    props.onAdd();
  };
  const focusIf = (which: "add" | "remove") => (element: HTMLElement) => {
    if (focusNext !== which) return;
    focusNext = null;
    queueMicrotask(() => element.isConnected && element.focus());
  };
  return (
    <Show
      when={props.quoting}
      fallback={
        <button type="button" class="mail-quote-add" ref={focusIf("add")} disabled={props.disabled} onClick={add} data-mail-quote-add>
          <i class="ti ti-plus" aria-hidden="true" />
          {t().quoteAdd}
        </button>
      }
    >
      <Switch>
        <Match when={props.state.status === "loading"}>
          <div class="mail-quote-card" data-loading="" role="status" aria-label={t().quoteLoading} data-mail-quote-card>
            <div class="mail-quote-card-head">
              <Skeleton class="mail-quote-card-skeleton-avatar" />
              <Skeleton class="mail-quote-card-skeleton-name" />
            </div>
            <div class="mail-quote-card-text">
              <Skeleton class="mail-quote-card-skeleton-line" />
              <Skeleton class="mail-quote-card-skeleton-line" />
            </div>
            <Skeleton class="mail-quote-card-skeleton-more" />
          </div>
        </Match>
        <Match when={props.state.status === "failed"}>
          <div class="mail-quote-card" data-failed="" role="alert" data-mail-quote-card>
            <p class="mail-quote-card-failed">{t().quoteLoadFailed}</p>
            <div class="mail-quote-card-actions">
              <Button size="sm" variant="secondary" type="button" onClick={props.onRetry}>
                {t().quoteRetry}
              </Button>
              <Button size="sm" variant="ghost" type="button" disabled={props.disabled} onClick={remove}>
                {t().quoteRemove}
              </Button>
            </div>
          </div>
        </Match>
        <Match when={props.state.status === "ready" && props.state.original}>
          {(original) => (
            <section
              class="mail-quote-card"
              data-open={open() ? "" : undefined}
              aria-label={t().quoteCard({ name: original().name })}
              data-mail-quote-card
            >
              <header class="mail-quote-card-head">
                <Avatar name={original().name} size="xs" />
                <span class="mail-quote-card-name">{original().name}</span>
                <span class="mail-quote-card-date">{original().date}</span>
                <IconButton
                  size="sm"
                  variant="ghost"
                  type="button"
                  class="mail-quote-card-remove"
                  label={t().quoteRemove}
                  ref={focusIf("remove")}
                  disabled={props.disabled}
                  onClick={remove}
                >
                  <i class="ti ti-x" aria-hidden="true" />
                </IconButton>
              </header>
              <div class="mail-quote-card-text" id={textId}>
                {(open() ? paragraphs(original().text) : firstLines(original().text)).map((line) => (
                  <p>{line}</p>
                ))}
              </div>
              <Show when={hidesText(original().text)}>
                <button
                  type="button"
                  class="mail-quote-card-more"
                  aria-expanded={open()}
                  aria-controls={textId}
                  onClick={() => setOpen((value) => !value)}
                >
                  {open() ? t().quoteShowLess : t().quoteShowAll}
                </button>
              </Show>
            </section>
          )}
        </Match>
      </Switch>
    </Show>
  );
}
