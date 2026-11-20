import { dates, i18n } from "@k2b/stdlib";
import { ButtonLink, type ChatActivityItem } from "@k2b/ui";
import type { AiStoredMessage } from "../types";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      chat: "Delegated work",
      completed: "is done",
      failed: "failed",
      aborted: "was stopped",
      open: "View result",
      inspect: "View chat",
      today: "today",
    },
    de: {
      chat: "Weitergegebener Auftrag",
      completed: "ist fertig",
      failed: "ist fehlgeschlagen",
      aborted: "wurde abgebrochen",
      open: "Ergebnis ansehen",
      inspect: "Chat ansehen",
      today: "heute",
    },
  },
});

/** Shared Chat.Activity, with a normal link: reload and Back keep the exact result's position. */
export function aiChatDoneItem(entry: AiStoredMessage, locale: string, timeZone?: string, renderedAt?: string): ChatActivityItem {
  const done = entry.meta!.chatDone!;
  const t = messages.resolve([locale]).t;
  const action = done.status === "completed" ? t.open : t.inspect;
  const dateContext = { locale, timeZone, base: renderedAt };
  const day =
    dates.formatDateKey(entry.createdAt, dateContext) === dates.formatDateKey(renderedAt ?? new Date(), dateContext)
      ? t.today
      : dates.formatDateRelative(entry.createdAt, dateContext);
  return {
    kind: "activity",
    id: entry.id,
    anchorId: entry.seq,
    class: "ai-chat-done-line",
    tone: done.status === "completed" ? "success" : done.status === "failed" ? "danger" : "neutral",
    icon: done.status === "completed" ? "ti ti-circle-check" : done.status === "failed" ? "ti ti-alert-circle" : "ti ti-circle-minus",
    label: (
      <>
        <b>{done.name ?? t.chat}</b> {t[done.status]}
        {done.status === "completed" && done.summary ? `: ${done.summary}` : ""}
        {timeZone && (
          <time datetime={entry.createdAt}>
            {" "}
            · {day}, {dates.formatTime(entry.createdAt, { locale, timeZone })}
          </time>
        )}
      </>
    ),
    trailing: done.href && (
      <ButtonLink aria-label={`${action}: ${done.name ?? t.chat}`} href={done.href} navigation="document" variant="secondary" size="sm">
        <i class="ti ti-arrow-up-right" aria-hidden="true" />
        {action}
      </ButtonLink>
    ),
  };
}
