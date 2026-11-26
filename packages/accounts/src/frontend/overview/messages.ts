import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";

/** The words of the Accounts overview on v2 that the shared catalog does not have. */
export const overviewMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      views: "Views",
      activity: "Activity",
      yourAccount: "Your account",
      yourGroups: "Your groups",
      noGroups: "You are not in any group yet.",
      youManage: "you manage",
      active: "Active",
      expiresOn: ({ when }: { when: string }) => `expires ${when}`,
      expiredOn: ({ when }: { when: string }) => `Expired ${when}`,
      noExpiry: "does not expire",
      logs: "Logs",
      waiting: ({ count, text }: { count: number; text: string }) =>
        i18n.plural(count, "en", { one: "1 waiting", other: `${text} waiting` }),
      noneWaiting: "none waiting",
      accounts: ({ count, text }: { count: number; text: string }) =>
        i18n.plural(count, "en", { one: "1 account", other: `${text} accounts` }),
      expiringSplit: ({ freeIpa, local, guests }: { freeIpa: string; local: string; guests: string }) =>
        `${freeIpa} FreeIPA · ${local} local · ${guests} guests`,
      sourceCounts: ({ freeIpa, local }: { freeIpa: string; local: string }) => `${freeIpa} FreeIPA · ${local} local`,
      synced: "Synced",
      noErrors: "no errors",
      failedRuns: ({ count }: { count: number }) => i18n.plural(count, "en", { one: "1 run failed", other: `${count} runs failed` }),
      runsOk: ({ ok, runs }: { ok: number; runs: number }) => `${ok} of ${runs} runs without errors`,
      errors: ({ count }: { count: number }) => i18n.plural(count, "en", { one: "1 error", other: `${count} errors` }),
      levelError: "Error",
      levelWarn: "Warning",
    },
    de: {
      views: "Ansichten",
      activity: "Aktivität",
      yourAccount: "Dein Konto",
      yourGroups: "Deine Gruppen",
      noGroups: "Du bist noch in keiner Gruppe.",
      youManage: "verwaltest du",
      active: "Aktiv",
      expiresOn: ({ when }) => `läuft ab ${when}`,
      expiredOn: ({ when }) => `Abgelaufen am ${when}`,
      noExpiry: "läuft nicht ab",
      logs: "Protokolle",
      waiting: ({ count, text }) => i18n.plural(count, "de", { one: "1 wartet", other: `${text} warten` }),
      noneWaiting: "keine offen",
      accounts: ({ count, text }) => i18n.plural(count, "de", { one: "1 Konto", other: `${text} Konten` }),
      expiringSplit: ({ freeIpa, local, guests }) => `${freeIpa} FreeIPA · ${local} lokal · ${guests} Gäste`,
      sourceCounts: ({ freeIpa, local }) => `${freeIpa} FreeIPA · ${local} lokal`,
      synced: "Synchronisiert",
      noErrors: "ohne Fehler",
      failedRuns: ({ count }) => i18n.plural(count, "de", { one: "1 Lauf mit Fehler", other: `${count} Läufe mit Fehler` }),
      runsOk: ({ ok, runs }) => `${ok} von ${runs} Läufen ohne Fehler`,
      errors: ({ count }) => `${count} Fehler`,
      levelError: "Fehler",
      levelWarn: "Warnung",
    },
  },
});

export type OverviewMessages = ReturnType<typeof overviewMessages.resolve>["t"];

export const useOverviewMessages = () => {
  const locale = useLocale();
  return createMemo(() => overviewMessages.resolve([locale()]).t);
};
