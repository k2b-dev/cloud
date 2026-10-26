import { i18n } from "@k2b/stdlib";
import { isNotebookActivityAction } from "../lib/activity-actions";

type OverviewTarget = { target: string; notebook: string };
type MessageOptions = OverviewTarget & { self: boolean; overview: boolean };
type ActivityMessage = (options: MessageOptions) => string;
const label =
  (named: string, self: string, overview: (target: OverviewTarget) => string): ActivityMessage =>
  (options) =>
    options.overview ? overview(options) : options.self ? self : named;

/**
 * One catalog for note predicates and overview sentences. It stays exhaustive: the describers below index it with
 * every `NotebookActivityAction`, so a missing English key fails the typecheck, and the localization check holds
 * German to the same keys.
 */
export const activityMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      "notebook.created": label("created the notebook", "created the notebook", ({ notebook }) => `Created ${notebook}`),
      "note.created": label("created the note", "created the note", ({ target, notebook }) => `Created ${target} in ${notebook}`),
      "note.edited": label("edited", "edited", ({ target, notebook }) => `Edited ${target} in ${notebook}`),
      "note.restored": label("restored a version", "restored a version", ({ target, notebook }) => `Restored ${target} in ${notebook}`),
      "annotation.create": label("commented on a passage", "commented on a passage", ({ target, notebook }) => `Commented on a passage in ${target} in ${notebook}`),
      "comment.created": label("commented", "commented", ({ target, notebook }) => `Commented on ${target} in ${notebook}`),
      "comment.updated": label(
        "changed a comment",
        "changed a comment",
        ({ target, notebook }) => `Updated a comment on ${target} in ${notebook}`,
      ),
      "comment.deleted": label(
        "deleted a comment",
        "deleted a comment",
        ({ target, notebook }) => `Deleted a comment from ${target} in ${notebook}`,
      ),
      unknown: label("changed the note", "changed the note", ({ notebook }) => `Changed a note in ${notebook}`),
    },
    de: {
      "notebook.created": label("hat das Notizbuch erstellt", "hast das Notizbuch erstellt", ({ notebook }) => `${notebook} erstellt`),
      "note.created": label(
        "hat die Notiz erstellt",
        "hast die Notiz erstellt",
        ({ target, notebook }) => `${target} in ${notebook} erstellt`,
      ),
      "note.edited": label("hat bearbeitet", "hast bearbeitet", ({ target, notebook }) => `${target} in ${notebook} bearbeitet`),
      "note.restored": label(
        "hat eine Version wiederhergestellt",
        "hast eine Version wiederhergestellt",
        ({ target, notebook }) => `${target} in ${notebook} wiederhergestellt`,
      ),
      "annotation.create": label("hat eine Textstelle kommentiert", "hast eine Textstelle kommentiert", ({ target, notebook }) => `Eine Textstelle in ${target} in ${notebook} kommentiert`),
      "comment.created": label("hat kommentiert", "hast kommentiert", ({ target, notebook }) => `${target} in ${notebook} kommentiert`),
      "comment.updated": label(
        "hat einen Kommentar geändert",
        "hast einen Kommentar geändert",
        ({ target, notebook }) => `Einen Kommentar zu ${target} in ${notebook} aktualisiert`,
      ),
      "comment.deleted": label(
        "hat einen Kommentar gelöscht",
        "hast einen Kommentar gelöscht",
        ({ target, notebook }) => `Einen Kommentar zu ${target} in ${notebook} gelöscht`,
      ),
      unknown: label("hat die Notiz geändert", "hast die Notiz geändert", ({ notebook }) => `Eine Notiz in ${notebook} geändert`),
    },
  },
});

/** Sentence predicate following a named actor, or You/Du when self is true. */
export const describeNoteActivity = (action: string, options: { self: boolean; locale: string }): string => {
  const { t } = activityMessages.resolve([options.locale]);
  return t[isNotebookActivityAction(action) ? action : "unknown"]({ ...options, overview: false, target: "", notebook: "" });
};

export const describeOverviewActivity = (action: string, options: OverviewTarget & { locale: string }): string => {
  const { t } = activityMessages.resolve([options.locale]);
  return t[isNotebookActivityAction(action) ? action : "unknown"]({ ...options, self: false, overview: true });
};
