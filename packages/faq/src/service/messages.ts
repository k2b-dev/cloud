import { i18n } from "@k2b/stdlib";

const catalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      notFound: "FAQ entry not found",
      createFailed: "The FAQ entry could not be created",
      updateFailed: "The FAQ entry could not be updated",
      deleteFailed: "The FAQ entry could not be deleted",
      reorderFailed: "The FAQ entries could not be reordered",
      duplicateIds: "FAQ IDs must be unique",
      deleted: "FAQ entry deleted",
      reordered: "FAQ entries reordered",
      invalidRequest: "The FAQ request is invalid",
    },
    de: {
      notFound: "Der FAQ-Eintrag wurde nicht gefunden",
      createFailed: "Der FAQ-Eintrag konnte nicht erstellt werden",
      updateFailed: "Der FAQ-Eintrag konnte nicht aktualisiert werden",
      deleteFailed: "Der FAQ-Eintrag konnte nicht gelöscht werden",
      reorderFailed: "Die FAQ-Einträge konnten nicht neu angeordnet werden",
      duplicateIds: "FAQ-IDs müssen eindeutig sein",
      deleted: "FAQ-Eintrag gelöscht",
      reordered: "FAQ-Einträge neu angeordnet",
      invalidRequest: "Die FAQ-Anfrage ist ungültig",
    },
  },
});

export const faqServiceMessages = (locale?: string | null) => catalog.resolve(locale ? [locale] : []).t;

export const checkFaqServiceMessages = () => catalog.check();

export const faqApiErrorMessage = (status: number, locale?: string | null, baseMessage?: string): string => {
  const resolved = catalog.resolve(locale ? [locale] : []);
  if (resolved.locale === "en" && baseMessage) return baseMessage;
  const { t } = resolved;
  if (status === 404) return t.notFound;
  if (status >= 500) return t.updateFailed;
  return t.invalidRequest;
};
