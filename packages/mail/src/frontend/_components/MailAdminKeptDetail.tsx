import type { DateContext } from "@k2b/stdlib";
import { dates } from "@k2b/stdlib";
import { StatusBadge, type StatusTone, useLocale } from "@k2b/ui";
import { createMemo, For, Show } from "solid-js";
import type { KeptConversationExport } from "../../contracts";
import type { KeepHistoryEntry } from "../../service/kept-conversations";
import { mailKeptAdminMessages } from "../kept-admin-messages";
import MailAdminKeptActions from "./MailAdminKeptActions.island";

type KeptConversation = KeptConversationExport["conversations"][number];
type Address = KeptConversation["messages"][number]["from"][number];
type DeliveryState = NonNullable<KeptConversation["messages"][number]["delivery"]>["state"];

const addressText = (addresses: readonly Address[]): string =>
  addresses.map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address)).join(", ");

const formatBytes = (value: number, locale: string): string => {
  const format = (number: number, digits: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(number);
  if (value < 1024) return `${format(value, 0)} B`;
  if (value < 1024 * 1024) return `${format(value / 1024, 1)} KB`;
  return `${format(value / (1024 * 1024), 1)} MB`;
};

/**
 * Stored HTML is already sanitized. The frame still runs nothing and loads nothing from the network, so opening kept
 * mail as evidence can't execute content or tell a sender that an administrator read it.
 */
const htmlFrameDocument = (html: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#18181b;background:#fff;overflow-wrap:anywhere}</style></head><body>${html}</body></html>`;

/** One kept conversation in Admin › Mail › Kept: who kept it, its messages, its logged history, and its actions. */
export default function MailAdminKeptDetail(props: {
  conversation: KeptConversation;
  history: KeepHistoryEntry[];
  /** All messages of the conversation; the detail shows the newest ones, the JSON download has every message. */
  messageCount: number;
  dateConfig: DateContext;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailKeptAdminMessages.resolve([locale()]).t);
  // Cloud's own outgoing copy is evidence only of what Cloud did with it: a cancelled or scheduled message never left.
  const delivery = (state: DeliveryState): { label: string; tone: StatusTone } => {
    if (state === "scheduled") return { label: t().deliveryScheduled, tone: "neutral" };
    if (state === "undo_window") return { label: t().deliveryPending, tone: "neutral" };
    if (state === "sending") return { label: t().deliverySending, tone: "neutral" };
    if (state === "accepted" || state === "sent_sync_pending" || state === "sent" || state === "reconciled_accepted")
      return { label: t().deliverySent, tone: "ok" };
    if (state === "failed") return { label: t().deliveryFailed, tone: "error" };
    if (state === "cancelled" || state === "reconciled_unsent") return { label: t().deliveryNotSent, tone: "warning" };
    return { label: t().deliveryUnknown, tone: "warning" };
  };
  const historyLabel = (entry: KeepHistoryEntry): string => {
    if (entry.action === "mail.conversation.keep") return t().historyKept;
    if (entry.action === "mail.conversation.keep.release")
      return entry.outcome === "allowed" ? t().historyReleased : t().historyReleaseDenied;
    if (entry.action === "mail.conversation.keep.view") return t().historyViewed;
    if (entry.action === "mail.conversation.keep.export") return t().historyExported;
    return t().historyOther({ action: entry.action });
  };
  return (
    <article class="flex max-w-4xl flex-col gap-6" data-kept-detail>
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h1 class="text-lg font-semibold text-primary">{props.conversation.subject?.trim() || t().noSubject}</h1>
          <p class="mt-1 flex items-center gap-1.5 text-xs text-secondary" data-kept-since>
            <i class="ti ti-lock text-dimmed" aria-hidden="true" />
            {t().keptSince({
              date: dates.formatDateTime(props.conversation.keep.keptAt, props.dateConfig),
              name: props.conversation.keep.keptBy.displayName,
            })}
          </p>
          <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt class="text-dimmed">{t().mailboxLabel}</dt>
            <dd class="text-secondary">{props.conversation.mailbox.name}</dd>
            <dt class="text-dimmed">{t().cloudId}</dt>
            <dd class="font-mono text-secondary">{props.conversation.cloudId}</dd>
          </dl>
        </div>
        <MailAdminKeptActions mailboxId={props.conversation.mailbox.id} conversationId={props.conversation.conversationId} />
      </header>

      <section class="flex flex-col gap-8" aria-label={t().messages({ count: props.messageCount })}>
        <h2 class="text-xs font-semibold text-dimmed">{t().messages({ count: props.messageCount })}</h2>
        <Show when={props.messageCount > props.conversation.messages.length}>
          <p class="text-xs text-secondary" data-kept-truncated>
            {t().truncated({ shown: props.conversation.messages.length, total: props.messageCount })}
          </p>
        </Show>
        <For each={props.conversation.messages}>
          {(message) => (
            <section class="flex flex-col gap-3" data-kept-message>
              <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                <dt class="text-dimmed">{t().from}</dt>
                <dd class="font-medium text-primary">{addressText(message.from) || t().unknownSender}</dd>
                <Show when={message.to.length}>
                  <dt class="text-dimmed">{t().to}</dt>
                  <dd class="text-secondary">{addressText(message.to)}</dd>
                </Show>
                <Show when={message.cc.length}>
                  <dt class="text-dimmed">{t().cc}</dt>
                  <dd class="text-secondary">{addressText(message.cc)}</dd>
                </Show>
                <Show when={message.bcc.length}>
                  <dt class="text-dimmed">{t().bcc}</dt>
                  <dd class="text-secondary">{addressText(message.bcc)}</dd>
                </Show>
                <Show when={message.replyTo.length}>
                  <dt class="text-dimmed">{t().replyTo}</dt>
                  <dd class="text-secondary">{addressText(message.replyTo)}</dd>
                </Show>
                <Show when={message.delivery}>
                  {(record) => (
                    <>
                      <dt class="text-dimmed">{t().delivery}</dt>
                      <dd>
                        <StatusBadge tone={delivery(record().state).tone} label={delivery(record().state).label} />
                      </dd>
                    </>
                  )}
                </Show>
                <dt class="text-dimmed">{t().date}</dt>
                <dd class="text-secondary">
                  <time dateTime={message.date}>{dates.formatDateTime(message.date, props.dateConfig)}</time>
                </dd>
                <Show when={message.messageId}>
                  <dt class="text-dimmed">{t().messageIdHeader}</dt>
                  <dd class="break-all font-mono text-[11px] text-dimmed">{message.messageId}</dd>
                </Show>
              </dl>
              {message.text ? (
                <div class="whitespace-pre-wrap break-words text-sm text-primary">{message.text}</div>
              ) : message.html ? (
                <div class="h-56 min-h-24 resize-y overflow-hidden rounded-md bg-white">
                  <iframe
                    class="h-full w-full"
                    sandbox=""
                    referrerpolicy="no-referrer"
                    title={message.subject ?? t().noSubject}
                    srcdoc={htmlFrameDocument(message.html)}
                  />
                </div>
              ) : (
                <p class="text-xs text-dimmed">{t().noBody}</p>
              )}
              <Show when={message.attachments.length}>
                <div class="flex flex-col gap-1">
                  <h3 class="text-xs font-semibold text-dimmed">{t().attachments}</h3>
                  <ul class="flex flex-col gap-0.5 text-xs text-secondary">
                    <For each={message.attachments}>
                      {(attachment) => (
                        <li class="flex items-center gap-1.5">
                          <i class="ti ti-paperclip text-dimmed" aria-hidden="true" />
                          <span class="truncate">{attachment.filename ?? attachment.contentType}</span>
                          <span class="shrink-0 text-dimmed">
                            {attachment.contentType} · {formatBytes(attachment.size, locale())}
                            {attachment.inline ? ` · ${t().inline}` : ""}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
            </section>
          )}
        </For>
      </section>

      <section class="flex flex-col gap-2" data-kept-history>
        <h2 class="text-xs font-semibold text-dimmed">{t().history}</h2>
        <Show when={props.history.length} fallback={<p class="text-xs text-dimmed">{t().historyEmpty}</p>}>
          <ol class="flex flex-col gap-2">
            <For each={props.history}>
              {(entry) => (
                <li class="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <time class="w-36 shrink-0 text-dimmed" dateTime={entry.at}>
                    {dates.formatDateTime(entry.at, props.dateConfig)}
                  </time>
                  <span class="min-w-0 flex-1">
                    <span class="font-medium text-primary">{entry.actor.label}</span>{" "}
                    <span class={entry.outcome === "allowed" ? "text-secondary" : "text-red-600 dark:text-red-400"}>
                      {historyLabel(entry)}
                    </span>
                    <Show when={entry.reason}>
                      {(reason) => <span class="block text-dimmed">{t().historyReason({ reason: reason() })}</span>}
                    </Show>
                  </span>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </section>
    </article>
  );
}
