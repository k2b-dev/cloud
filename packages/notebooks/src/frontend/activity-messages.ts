import { i18n } from "@k2b/stdlib";
import { isNotebookActivityAction, type NotebookActivityAction } from "../lib/activity-actions";

type ActivityMessage = (options: { self: boolean }) => string;
const label =
  (named: string, self: string): ActivityMessage =>
  (options) =>
    options.self ? self : named;

/**
 * One catalog for note predicates. It stays exhaustive: the describers below index it with
 * every `NotebookActivityAction`, so a missing English key fails the typecheck, and the localization check holds
 * German to the same keys.
 */
export const activityMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      "notebook.created": label("created the notebook", "created the notebook"),
      "note.created": label("created the note", "created the note"),
      "note.edited": label("edited", "edited"),
      "note.restored": label("restored a version", "restored a version"),
      "annotation.create": label("commented on a passage", "commented on a passage"),
      "comment.created": label("commented", "commented"),
      "comment.updated": label("changed a comment", "changed a comment"),
      "comment.deleted": label("deleted a comment", "deleted a comment"),
      unknown: label("changed the note", "changed the note"),
    },
    de: {
      "notebook.created": label("hat das Notizbuch erstellt", "hast das Notizbuch erstellt"),
      "note.created": label("hat die Notiz erstellt", "hast die Notiz erstellt"),
      "note.edited": label("hat bearbeitet", "hast bearbeitet"),
      "note.restored": label("hat eine Version wiederhergestellt", "hast eine Version wiederhergestellt"),
      "annotation.create": label("hat eine Textstelle kommentiert", "hast eine Textstelle kommentiert"),
      "comment.created": label("hat kommentiert", "hast kommentiert"),
      "comment.updated": label("hat einen Kommentar geändert", "hast einen Kommentar geändert"),
      "comment.deleted": label("hat einen Kommentar gelöscht", "hast einen Kommentar gelöscht"),
      unknown: label("hat die Notiz geändert", "hast die Notiz geändert"),
    },
  },
});

/** Sentence predicate following a named actor, or You/Du when self is true. */
export const describeNoteActivity = (action: string, options: { self: boolean; locale: string }): string => {
  const { t } = activityMessages.resolve([options.locale]);
  return t[isNotebookActivityAction(action) ? action : "unknown"](options);
};

/** A note's own timeline names what happened without the person; the person stands in the meta line. */
export const noteActivitySentences = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      "notebook.created": "Notebook created",
      "note.created": "Note created",
      "note.edited": "Edited",
      "note.restored": "Version restored",
      "annotation.create": "Passage commented on",
      "comment.created": "Commented",
      "comment.updated": "Comment changed",
      "comment.deleted": "Comment deleted",
      unknown: "Note changed",
    },
    de: {
      "notebook.created": "Notizbuch erstellt",
      "note.created": "Notiz erstellt",
      "note.edited": "Bearbeitet",
      "note.restored": "Version wiederhergestellt",
      "annotation.create": "Textstelle kommentiert",
      "comment.created": "Kommentiert",
      "comment.updated": "Kommentar geändert",
      "comment.deleted": "Kommentar gelöscht",
      unknown: "Notiz geändert",
    },
  },
});

export const describeNoteActivityEntry = (action: string, locale: string): string =>
  noteActivitySentences.resolve([locale]).t[isNotebookActivityAction(action) ? action : "unknown"];

const activityIcons = {
  "notebook.created": "ti ti-notebook",
  "note.created": "ti ti-plus",
  "note.edited": "ti ti-pencil",
  "note.restored": "ti ti-history",
  "annotation.create": "ti ti-message-plus",
  "comment.created": "ti ti-message-plus",
  "comment.updated": "ti ti-message-pencil",
  "comment.deleted": "ti ti-message-x",
} satisfies Record<NotebookActivityAction, string>;

/** One fixed icon per kind of activity. */
export const notebookActivityIcon = (action: string): string =>
  isNotebookActivityAction(action) ? activityIcons[action] : "ti ti-activity";
