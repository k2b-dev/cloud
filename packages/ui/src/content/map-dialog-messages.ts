import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";
import type { GeoNavigationPlatform } from "./map-navigation";

const mapDialogMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      open: "Open map",
      close: "Close",
      more: "More actions",
      places: "Places",
      copyAddress: "Copy address",
      copied: "Copied",
      navigate: ({ platform }: { platform: GeoNavigationPlatform }): string =>
        platform === "ios" ? "Open in Apple Maps" : platform === "android" ? "Open in maps app" : "Open in OpenStreetMap",
      loading: "Loading places …",
      empty: "No places on this map.",
      enlarge: "Enlarge list",
      shrink: "Shrink list",
      noLocation: "Location denied · allow it in your browser",
      locationFailed: "Location unavailable",
    },
    de: {
      open: "Karte öffnen",
      close: "Schließen",
      more: "Weitere Aktionen",
      places: "Orte",
      copyAddress: "Adresse kopieren",
      copied: "Kopiert",
      navigate: ({ platform }) =>
        platform === "ios" ? "In Apple Karten öffnen" : platform === "android" ? "In Navi-App öffnen" : "In OpenStreetMap öffnen",
      loading: "Orte werden geladen …",
      empty: "Keine Orte auf dieser Karte.",
      enlarge: "Liste vergrößern",
      shrink: "Liste verkleinern",
      noLocation: "Standort nicht erlaubt · im Browser freigeben",
      locationFailed: "Standort nicht verfügbar",
    },
  },
});
export const useMapDialogMessages = () => {
  const locale = useLocale();
  return () => mapDialogMessages.resolve([locale()]).t;
};
export const checkMapDialogMessages = () => mapDialogMessages.check();
