import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const richSelectMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      back: "Back",
      choose: "Choose",
      chooseOption: "Choose option",
      close: "Close",
      couldNotLoad: "Could not be loaded.",
      create: "Create",
      detailsFor: ({ name }: { name: string }) => `Details: ${name}`,
      loading: "Loading options",
      noOptions: "No options available",
      noResults: "No results found",
      retry: "Retry",
      search: "Search",
    },
    de: {
      back: "Zurück",
      choose: "Auswählen",
      chooseOption: "Option auswählen",
      close: "Schließen",
      couldNotLoad: "Konnte nicht geladen werden.",
      create: "Anlegen",
      detailsFor: ({ name }) => `Details: ${name}`,
      loading: "Optionen werden geladen",
      noOptions: "Keine Optionen verfügbar",
      noResults: "Keine Ergebnisse gefunden",
      retry: "Erneut versuchen",
      search: "Suchen",
    },
  },
});

export type RichSelectMessages = ReturnType<(typeof richSelectMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useRichSelectMessages = (): (() => RichSelectMessages) => {
  const locale = useLocale();
  return () => richSelectMessages.resolve([locale()]).t;
};

export const checkRichSelectMessages = () => richSelectMessages.check();
