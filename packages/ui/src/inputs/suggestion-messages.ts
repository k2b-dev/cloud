import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

type Source = { source?: string };

const suggestionMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      suggestion: "Suggestion",
      accept: "Accept",
      acceptFor: ({ label }: { label?: string }) => (label ? `Accept suggestion for ${label}` : "Accept suggestion"),
      unsure: "unsure",
      acceptedFrom: ({ source }: Source) => (source ? `from ${source}` : "accepted"),
      offered: ({ source, value }: Source & { value: string }) => `${source ?? "Suggestion"}: ${value}`,
      loading: ({ source }: Source) => (source ? `${source} is reading …` : "Loading suggestion …"),
      failed: "no suggestion",
      retry: "Retry",
      yes: "Yes",
      no: "No",
      switchValue: ({ value }: { value: string }) => `Suggestion: ${value}`,
      describeOpen: ({ source, value }: Source & { value?: string }) =>
        `${source ? `Suggestion from ${source}` : "Suggestion"}${value ? `: ${value}` : ""}, not accepted.`,
      describeOffered: ({ source, value }: Source & { value: string }) =>
        source ? `${source} suggests ${value}, not accepted.` : `Suggested ${value}, not accepted.`,
      describeAccepted: ({ source }: Source) => (source ? `Accepted from ${source}.` : "Accepted from the suggestion."),
      describeLoading: ({ source }: Source) => (source ? `${source} is reading.` : "Loading a suggestion."),
      describeFailed: "No suggestion.",
      describeUnsure: ({ reason }: { reason?: string }) => (reason ? `Unsure: ${reason}` : "Unsure."),
      announceAccepted: ({ label, value }: { label?: string; value: string }) =>
        label ? `${label} accepted: ${value}.` : `Accepted: ${value}.`,
      announceOffered: ({ source, label, value, own }: Source & { label?: string; value: string; own: string }) =>
        `${source ?? "A suggestion"} suggests ${value}${label ? ` for ${label}` : ""}. Your value ${own} stays.`,
      groupTitle: ({ source }: Source) => (source ? `Suggestions from ${source}` : "Suggestions"),
      countAccepted: ({ count }: { count: number }) => `${count} accepted`,
      countOpen: ({ count }: { count: number }) => `${count} open`,
      countUnsure: ({ count }: { count: number }) => `${count} unsure`,
      acceptAll: ({ count }: { count: number }) => `Accept all (${count})`,
      retryAll: "Try again",
      announceAcceptedAll: ({ count, unsure }: { count: number; unsure: readonly string[] }) =>
        `${count === 1 ? "1 suggestion" : `${count} suggestions`} accepted.${
          unsure.length
            ? ` ${unsure.length === 1 ? "1 unsure value stays" : `${unsure.length} unsure values stay`} open: ${unsure.join(", ")}.`
            : ""
        }`,
    },
    de: {
      suggestion: "Vorschlag",
      accept: "Übernehmen",
      acceptFor: ({ label }) => (label ? `Vorschlag für ${label} übernehmen` : "Vorschlag übernehmen"),
      unsure: "unsicher",
      acceptedFrom: ({ source }) => (source ? `von ${source}` : "übernommen"),
      offered: ({ source, value }) => `${source ?? "Vorschlag"}: ${value}`,
      loading: ({ source }) => (source ? `${source} liest …` : "Vorschlag lädt …"),
      failed: "kein Vorschlag",
      retry: "Erneut",
      yes: "Ja",
      no: "Nein",
      switchValue: ({ value }) => `Vorschlag: ${value}`,
      describeOpen: ({ source, value }) =>
        `${source ? `Vorschlag von ${source}` : "Vorschlag"}${value ? `: ${value}` : ""}, nicht übernommen.`,
      describeOffered: ({ source, value }) =>
        source ? `${source} schlägt ${value} vor, nicht übernommen.` : `Vorschlag ${value}, nicht übernommen.`,
      describeAccepted: ({ source }) => (source ? `Von ${source} übernommen.` : "Aus dem Vorschlag übernommen."),
      describeLoading: ({ source }) => (source ? `${source} liest.` : "Ein Vorschlag lädt."),
      describeFailed: "Kein Vorschlag.",
      describeUnsure: ({ reason }) => (reason ? `Unsicher: ${reason}` : "Unsicher."),
      announceAccepted: ({ label, value }) => (label ? `${label} übernommen: ${value}.` : `Übernommen: ${value}.`),
      announceOffered: ({ source, label, value, own }) =>
        `${source ?? "Ein Vorschlag"} schlägt${label ? ` für ${label}` : ""} ${value} vor. Dein Wert ${own} bleibt.`,
      groupTitle: ({ source }) => (source ? `Vorschläge von ${source}` : "Vorschläge"),
      countAccepted: ({ count }) => `${count} übernommen`,
      countOpen: ({ count }) => `${count} offen`,
      countUnsure: ({ count }) => `${count} unsicher`,
      acceptAll: ({ count }) => `Alle übernehmen (${count})`,
      retryAll: "Erneut versuchen",
      announceAcceptedAll: ({ count, unsure }) =>
        `${count === 1 ? "1 Vorschlag" : `${count} Vorschläge`} übernommen.${
          unsure.length
            ? ` ${unsure.length === 1 ? "1 unsicherer Wert bleibt" : `${unsure.length} unsichere Werte bleiben`} offen: ${unsure.join(", ")}.`
            : ""
        }`,
    },
  },
});

export type SuggestionMessages = ReturnType<(typeof suggestionMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useSuggestionMessages = (): (() => SuggestionMessages) => {
  const locale = useLocale();
  return () => suggestionMessages.resolve([locale()]).t;
};

export const checkSuggestionMessages = () => suggestionMessages.check();
