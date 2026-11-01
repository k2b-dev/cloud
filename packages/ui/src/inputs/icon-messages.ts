import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const iconMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      filterIcons: "Filter icons",
      pickIcon: "Pick an icon...",
      recommended: "Recommended",
      people: "People",
      work: "Work",
      communication: "Communication",
      files: "Files",
      data: "Data & tech",
      commerce: "Commerce",
      places: "Places",
      food: "Food",
      media: "Media",
      devices: "Devices",
    },
    de: {
      filterIcons: "Symbole filtern",
      pickIcon: "Symbol auswählen...",
      recommended: "Empfohlen",
      people: "Personen",
      work: "Arbeit",
      communication: "Kommunikation",
      files: "Dateien",
      data: "Daten & Technik",
      commerce: "Handel",
      places: "Orte",
      food: "Essen",
      media: "Medien",
      devices: "Geräte",
    },
  },
});

export type IconMessages = ReturnType<(typeof iconMessages)["resolve"]>["t"];

export type IconGroupMessage = keyof Omit<IconMessages, "filterIcons" | "pickIcon">;

/** Resolved from the inherited render locale. */
/** The catalog locale the render locale resolves to, such as "de" for "de-AT". */
export const useIconLocale = (): (() => string) => {
  const locale = useLocale();
  return () => iconMessages.resolve([locale()]).locale;
};

export const useIconMessages = (): (() => IconMessages) => {
  const locale = useLocale();
  return () => iconMessages.resolve([locale()]).t;
};

export const checkIconMessages = () => iconMessages.check();
