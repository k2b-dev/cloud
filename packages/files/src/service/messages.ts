import { i18n, type ServiceError } from "@k2b/stdlib";

const catalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      invalidRequest: "The Files request is invalid",
      accessDenied: "You do not have access to this file storage",
      resourceNotFound: "The requested Files resource was not found",
      conflictingChange: "The Files change conflicts with the current state",
      operationFailed: "The Files operation failed",
    },
    de: {
      invalidRequest: "Die Files-Anfrage ist ungültig",
      accessDenied: "Du hast keinen Zugriff auf diesen Dateispeicher",
      resourceNotFound: "Die angeforderte Files-Ressource wurde nicht gefunden",
      conflictingChange: "Die Files-Änderung steht im Konflikt mit dem aktuellen Stand",
      operationFailed: "Der Files-Vorgang ist fehlgeschlagen",
    },
  },
});

export const filesServiceMessages = (locale?: string | null) => catalog.resolve(locale ? [locale] : []).t;
export const checkFilesServiceMessages = () => catalog.check();

export const filesApiErrorMessage = (status: number, locale?: string | null, baseMessage?: string): string => {
  const resolved = catalog.resolve(locale ? [locale] : []);
  if (resolved.locale === "en" && baseMessage) return baseMessage;
  const { t } = resolved;
  if (status === 401 || status === 403) return t.accessDenied;
  if (status === 404) return t.resourceNotFound;
  if (status === 409) return t.conflictingChange;
  if (status >= 500) return t.operationFailed;
  return t.invalidRequest;
};

export const localizeFilesError = (error: ServiceError, locale?: string | null): ServiceError => ({
  ...error,
  message: filesApiErrorMessage(error.status, locale, error.message),
});
