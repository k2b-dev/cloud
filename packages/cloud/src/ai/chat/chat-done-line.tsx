import { dates, i18n } from "@k2b/stdlib";
import { ButtonLink, type ChatActivityItem } from "@k2b/ui";
import type { AiStoredMessage } from "../types";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { chat: "Delegated work", completed: "is done", failed: "failed", aborted: "was stopped", open: "View result" },
    de: {
      chat: "Weitergegebener Auftrag",
      completed: "ist fertig",
      failed: "ist fehlgeschlagen",
      aborted: "wurde abgebrochen",
      open: "Ergebnis ansehen",
    },
  },
});

/** Shared Chat.Activity, with a normal link: reload and Back keep the exact result's position. */
export function aiChatDoneItem(entry: AiStoredMessage, locale: string, timeZone?: string): ChatActivityItem {
  const done = entry.meta!.chatDone!;
  const t = messages.resolve([locale]).t;
  return {
    kind: "activity",
    id: entry.id,
    anchorId: entry.seq,
    class: "ai-chat-done-line",
    tone: "ai",
    icon: done.status === "completed" ? "ti ti-circle-check" : done.status === "failed" ? "ti ti-alert-circle" : "ti ti-circle-minus",
    label: (
      <>
        <b>{done.name ?? t.chat}</b> {t[done.status]}
        {timeZone && <time datetime={entry.createdAt}> · {dates.formatTime(entry.createdAt, { locale, timeZone })}</time>}
      </>
    ),
    trailing: done.href && (
      <ButtonLink href={done.href} navigation="document" variant="secondary" size="sm">
        <i class="ti ti-arrow-up-right" aria-hidden="true" />
        {t.open}
      </ButtonLink>
    ),
  };
}
