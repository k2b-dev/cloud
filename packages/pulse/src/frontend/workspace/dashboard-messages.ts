import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";

export const dashboardMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      alarm: "Alarm",
      rejected: "The sharing change was rejected. Reload the dashboard to review it and try again.",
      replaceLink: "Publishing again replaces the existing public link. The previous link will stop working.",
    },
    de: {
      alarm: "Alarm",
      rejected: "Die Änderung der Freigabe wurde abgelehnt. Lade das Dashboard neu, prüfe die Freigabe und versuche es erneut.",
      replaceLink: "Erneutes Veröffentlichen ersetzt den bestehenden öffentlichen Link. Der bisherige Link funktioniert danach nicht mehr.",
    },
  },
});

export const useDashboardMessages = () => {
  const locale = useLocale();
  return () => dashboardMessages.resolve([locale()]).t;
};
