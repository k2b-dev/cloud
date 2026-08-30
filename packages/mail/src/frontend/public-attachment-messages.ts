import { i18n } from "@k2b/stdlib";

export const publicAttachmentMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Download attachment",
      attachment: "Attachment",
      instructions: "Enter the password supplied by the sender.",
      password: "Password",
      unlock: "Unlock download",
      notFound: "Attachment link not found",
      tooManyAttempts: "Too many unlock attempts. Try again later.",
      invalidPassword: "The password is incorrect or the link is no longer available.",
    },
    de: {
      title: "Anhang herunterladen",
      attachment: "Anhang",
      instructions: "Gib das Passwort ein, das du vom Absender erhalten hast.",
      password: "Passwort",
      unlock: "Download freigeben",
      notFound: "Der Link zum Anhang wurde nicht gefunden",
      tooManyAttempts: "Zu viele Entsperrversuche. Versuche es später erneut.",
      invalidPassword: "Das Passwort ist falsch oder der Link ist nicht mehr verfügbar.",
    },
  },
});
