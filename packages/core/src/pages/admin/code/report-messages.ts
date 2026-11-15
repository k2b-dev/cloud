import { i18n } from "@k2b/stdlib";
import type { CodePageReportReason } from "../../../code/page-provenance-contracts";

/** Texts of the reported pages under Administration › Code › an automation. */
export const codePageReportMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Reported pages",
      description: "Members reported pages of this automation. Its owner is not told.",
      open: "open",
      openMore: ({ n }: { n: number }) => `more than ${n} open`,
      failed: "The reports cannot be loaded right now.",
      reason: ({ reason }: { reason: CodePageReportReason }) =>
        ({
          security: "Security problem",
          suspicious: "Suspicious activity",
          false_information: "False information",
          illegal: "Illegal content",
          other: "Other",
        })[reason],
      noReason: "No reason chosen",
      by: ({ name, when }: { name: string; when: string }) => `${name} · ${when}`,
      openPage: ({ path }: { path: string }) => `Open page ${path}`,
      resolve: "Mark done",
      resolveFailed: "The report could not be marked done. It stays open.",
      more: "More reports",
      moreLoading: "Loading more reports…",
      moreFailed: "More reports cannot be loaded right now.",
    },
    de: {
      title: "Gemeldete Seiten",
      description: "Mitglieder haben Seiten dieser Automation gemeldet. Der Besitzer bekommt davon nichts.",
      open: "offen",
      openMore: ({ n }) => `mehr als ${n} offen`,
      failed: "Die Meldungen lassen sich gerade nicht laden.",
      reason: ({ reason }) =>
        ({
          security: "Sicherheitsproblem",
          suspicious: "Verdächtige Aktivität",
          false_information: "Falsche Angaben",
          illegal: "Rechtswidrige Inhalte",
          other: "Sonstiges",
        })[reason],
      noReason: "Ohne Grund",
      by: ({ name, when }) => `${name} · ${when}`,
      openPage: ({ path }) => `Seite ${path} öffnen`,
      resolve: "Erledigt",
      resolveFailed: "Die Meldung ließ sich nicht als erledigt markieren. Sie bleibt offen.",
      more: "Weitere Meldungen",
      moreLoading: "Weitere Meldungen werden geladen …",
      moreFailed: "Weitere Meldungen lassen sich gerade nicht laden.",
    },
  },
});
