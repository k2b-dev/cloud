import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";

/** The words of the audit log on v2 that the shared Accounts catalogs do not have. */
export const auditMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      last7d: "last 7 days",
      last30d: "last 30 days",
      last90d: "last 90 days",
      newestFirst: "Newest first",
      events: ({ count }: { count: string }) => `${count} events`,
      eventsOf: ({ count, total }: { count: string; total: string }) => `${count} of ${total} events`,
      noMatches: "No audit event matches these filters.",
      loadFailed: "The audit log could not be loaded.",
      automatic: "Automatic app entries",
    },
    de: {
      last7d: "letzte 7 Tage",
      last30d: "letzte 30 Tage",
      last90d: "letzte 90 Tage",
      newestFirst: "Neueste zuerst",
      events: ({ count }) => `${count} Einträge`,
      eventsOf: ({ count, total }) => `${count} von ${total} Einträgen`,
      noMatches: "Kein Audit-Eintrag passt zu diesen Filtern.",
      loadFailed: "Das Audit-Protokoll konnte nicht geladen werden.",
      automatic: "Automatische App-Einträge",
    },
  },
});

export type AuditMessages = ReturnType<typeof auditMessages.resolve>["t"];

export const useAuditMessages = () => {
  const locale = useLocale();
  return createMemo(() => auditMessages.resolve([locale()]).t);
};
