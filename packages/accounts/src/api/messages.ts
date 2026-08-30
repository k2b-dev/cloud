import { i18n } from "@k2b/stdlib";

const catalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      invalidRequest: "The Accounts request is invalid",
      accessDenied: "You do not have permission to perform this Accounts operation",
      resourceNotFound: "The requested Accounts resource was not found",
      conflictingChange: "The Accounts change conflicts with the current state",
      operationFailed: "The Accounts operation failed",
      userUpdated: "User updated.",
      avatarUpdated: "Avatar updated.",
      avatarDeleted: "Avatar deleted.",
      passwordReset: "Password reset.",
      notificationSent: "Notification sent.",
      loginLinkSent: "Login link sent.",
      userDeleted: "User permanently deleted",
      userDemoted: "User demoted to guest",
      apiKeyRevoked: "API key revoked.",
      groupDeleted: "Group deleted.",
      groupUpdated: "Group updated.",
      groupConverted: "Group converted to POSIX.",
      requestDenied: "Request denied",
    },
    de: {
      invalidRequest: "Die Accounts-Anfrage ist ungültig",
      accessDenied: "Du hast keine Berechtigung für diesen Accounts-Vorgang",
      resourceNotFound: "Die angeforderte Accounts-Ressource wurde nicht gefunden",
      conflictingChange: "Die Accounts-Änderung steht im Konflikt mit dem aktuellen Stand",
      operationFailed: "Der Accounts-Vorgang ist fehlgeschlagen",
      userUpdated: "Benutzer aktualisiert.",
      avatarUpdated: "Profilbild aktualisiert.",
      avatarDeleted: "Profilbild gelöscht.",
      passwordReset: "Passwort zurückgesetzt.",
      notificationSent: "Benachrichtigung gesendet.",
      loginLinkSent: "Anmeldelink gesendet.",
      userDeleted: "Benutzer endgültig gelöscht",
      userDemoted: "Benutzer zu Gast herabgestuft",
      apiKeyRevoked: "API-Schlüssel widerrufen.",
      groupDeleted: "Gruppe gelöscht.",
      groupUpdated: "Gruppe aktualisiert.",
      groupConverted: "Gruppe in eine POSIX-Gruppe umgewandelt.",
      requestDenied: "Anfrage abgelehnt",
    },
  },
});

export const accountsApiMessages = (locale?: string | null) => catalog.resolve(locale ? [locale] : []).t;
export const checkAccountsApiMessages = () => catalog.check();

export const accountsApiErrorMessage = (status: number, locale?: string | null, baseMessage?: string): string => {
  const resolved = catalog.resolve(locale ? [locale] : []);
  if (resolved.locale === "en" && baseMessage) return baseMessage;
  const { t } = resolved;
  if (status === 401 || status === 403) return t.accessDenied;
  if (status === 404) return t.resourceNotFound;
  if (status === 409) return t.conflictingChange;
  if (status >= 500) return t.operationFailed;
  return t.invalidRequest;
};
