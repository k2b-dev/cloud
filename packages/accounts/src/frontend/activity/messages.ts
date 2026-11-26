import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";

/** The words of the activity page: its name and its kinds. */
export const activityMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      activity: "Activity",
      kind: "Kind",
      audit: "Audit log",
      notifications: "Notifications",
      reminders: "Reminders",
      deleted: "Deleted accounts",
    },
    de: {
      activity: "Aktivität",
      kind: "Art",
      audit: "Protokoll",
      notifications: "Benachrichtigungen",
      reminders: "Erinnerungen",
      deleted: "Gelöschte Konten",
    },
  },
});

export const useActivityMessages = () => {
  const locale = useLocale();
  return createMemo(() => activityMessages.resolve([locale()]).t);
};
