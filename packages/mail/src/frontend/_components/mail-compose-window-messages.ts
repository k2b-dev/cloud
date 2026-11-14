import { i18n } from "@k2b/stdlib";

export const mailComposeWindowMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      newMessage: "New message",
      draftInDrafts: "Draft is in “Drafts”",
      open: "Open",
      sending: "Sending message",
      sendingIn: ({ seconds }: { seconds: number }) => `Sending in ${seconds} s`,
      undo: "Undo",
      scheduledFor: ({ value }: { value: string }) => `Scheduled for ${value}`,
      change: "Change",
      reopenFailed: "The draft could not be opened again.",
      offlineSaved: "Offline · saved here",
      uploading: ({ percent }: { percent: number }) => `Uploading · ${percent} %`,
      sendFailed: ({ reason }: { reason: string }) => `Not sent: ${reason} Your text is saved.`,
      sendAgain: "Send again",
    },
    de: {
      newMessage: "Neue Nachricht",
      draftInDrafts: "Entwurf liegt in „Entwürfe“",
      open: "Öffnen",
      sending: "Nachricht wird gesendet",
      sendingIn: ({ seconds }) => `Wird in ${seconds} s gesendet`,
      undo: "Rückgängig",
      scheduledFor: ({ value }) => `Geplant für ${value}`,
      change: "Ändern",
      reopenFailed: "Der Entwurf konnte nicht wieder geöffnet werden.",
      offlineSaved: "Offline · hier gesichert",
      uploading: ({ percent }) => `Lädt hoch · ${percent} %`,
      sendFailed: ({ reason }) => `Nicht gesendet: ${reason} Dein Text ist gespeichert.`,
      sendAgain: "Erneut senden",
    },
  },
});
