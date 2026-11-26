import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";

/** The words of the reminder history on v2 that the shared catalogs do not have. */
export const reminderMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      searchLabel: "Name, UID or email",
      newestFirst: "Newest first",
      noMatches: "No reminder matches these filters.",
      daysBefore: ({ when, count }: { when: string; count: number }) =>
        i18n.plural(count, "en", { one: `${when} · 1 day before`, other: `${when} · ${count} days before` }),
    },
    de: {
      searchLabel: "Name, UID oder E-Mail",
      newestFirst: "Neueste zuerst",
      noMatches: "Keine Erinnerung passt zu diesen Filtern.",
      daysBefore: ({ when, count }) => i18n.plural(count, "de", { one: `${when} · 1 Tag vorher`, other: `${when} · ${count} Tage vorher` }),
    },
  },
});

export const useReminderMessages = () => {
  const locale = useLocale();
  return createMemo(() => reminderMessages.resolve([locale()]).t);
};
