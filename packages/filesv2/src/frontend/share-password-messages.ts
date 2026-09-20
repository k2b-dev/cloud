import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";

export const sharePasswordMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      password: "Password (optional)",
      hint: "At least 8 characters. Share it separately from the link. Leave empty for access without a password.",
      protected: "Password protected",
      unlockTitle: "Protected share",
      unlockHint: "Enter the password you received from the sender.",
      enterPassword: "Password",
      unlock: "Unlock",
      failed: "Could not unlock the share. Check the password and try again.",
      limited: "Too many attempts. Wait a minute before trying again.",
    },
    de: {
      password: "Passwort (optional)",
      hint: "Mindestens 8 Zeichen. Teile es getrennt vom Link. Leer lassen für Zugriff ohne Passwort.",
      protected: "Passwortgeschützt",
      unlockTitle: "Geschützte Freigabe",
      unlockHint: "Gib das Passwort ein, das du vom Absender erhalten hast.",
      enterPassword: "Passwort",
      unlock: "Entsperren",
      failed: "Die Freigabe konnte nicht entsperrt werden. Prüfe das Passwort und versuche es erneut.",
      limited: "Zu viele Versuche. Warte eine Minute, bevor du es erneut versuchst.",
    },
  },
});
export const useSharePasswordMessages = () => {
  const locale = useLocale();
  return () => sharePasswordMessages.resolve([locale()]).t;
};
