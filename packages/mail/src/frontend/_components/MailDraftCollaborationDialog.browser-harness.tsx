import { type MailDraftCollaborationChoice, openMailDraftCollaborationDialog } from "./MailDraftCollaborationDialog";

declare global {
  interface Window {
    openDraftCollaboration: (locale: "en" | "de") => void;
    /** Each choice made in the dialog, in order. */
    collaborationChoices: Array<MailDraftCollaborationChoice | null>;
  }
}

window.collaborationChoices = [];

const holder = { kind: "user" as const, id: "10000000-0000-4000-8000-000000000001", displayName: "Ada Lovelace", avatarHash: null };

window.openDraftCollaboration = (locale) => {
  // Dialogs render outside the island and take the document's language, as in Cloud's pages.
  document.documentElement.lang = locale;
  void openMailDraftCollaborationDialog({
    // The same person in another tab: the longest German choice labels.
    conflict: {
      reason: "occupied",
      lease: { holder, acquiredAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() },
    },
    currentActor: { kind: holder.kind, id: holder.id },
    dateConfig: { locale, timeZone: "UTC" },
    locale,
  }).then((choice) => window.collaborationChoices.push(choice ?? null));
};
