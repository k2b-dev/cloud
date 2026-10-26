import { i18n } from "@k2b/stdlib";
import type { NotebookActivityEvent, NotebookActivityIdentity } from "./activity";

type Words = { actor: string; self: boolean };
export const activityTimelineMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      you: "You",
      system: "System",
      formerUser: "Former user",
      formerService: "Former service account",
      created: ({ actor }: Words) => `${actor} created the note`,
      edited: ({ actor }: Words) => `${actor} edited the note`,
      restored: ({ actor }: Words) => `${actor} restored a version of the note`,
      renamed: ({ actor }: Words) => `${actor} renamed the note`,
      moved: ({ actor }: Words) => `${actor} moved the note`,
      deleted: ({ actor }: Words) => `${actor} deleted the note`,
      changed: ({ actor }: Words) => `${actor} changed the note`,
    },
    de: {
      you: "Du",
      system: "System",
      formerUser: "Ehemaliger Benutzer",
      formerService: "Ehemaliges Dienstkonto",
      created: ({ actor, self }: Words) => `${actor} ${self ? "hast" : "hat"} die Notiz erstellt`,
      edited: ({ actor, self }: Words) => `${actor} ${self ? "hast" : "hat"} die Notiz bearbeitet`,
      restored: ({ actor, self }: Words) => `${actor} ${self ? "hast" : "hat"} eine Version der Notiz wiederhergestellt`,
      renamed: ({ actor, self }: Words) => `${actor} ${self ? "hast" : "hat"} die Notiz umbenannt`,
      moved: ({ actor, self }: Words) => `${actor} ${self ? "hast" : "hat"} die Notiz verschoben`,
      deleted: ({ actor, self }: Words) => `${actor} ${self ? "hast" : "hat"} die Notiz gelöscht`,
      changed: ({ actor, self }: Words) => `${actor} ${self ? "hast" : "hat"} die Notiz geändert`,
    },
  },
});

export const notebookActivityRow = (event: NotebookActivityEvent, options: { viewer: NotebookActivityIdentity; locale: string }) => {
  const { t } = activityTimelineMessages.resolve([options.locale]);
  const self = event.actor.kind === options.viewer.kind && event.actor.id !== null && event.actor.id === options.viewer.id;
  const actor =
    event.actor.kind === "system"
      ? t.system
      : event.actor.displayName === "Former user"
        ? t.formerUser
        : event.actor.displayName === "Former service account"
          ? t.formerService
          : event.actor.displayName.slice(0, 1000);
  const words = { actor: self ? t.you : actor, self };
  const describe =
    event.action === "note.created"
      ? t.created
      : event.action === "note.edited"
        ? t.edited
        : event.action === "note.restored"
          ? t.restored
          : event.action === "note.renamed"
            ? t.renamed
            : event.action === "note.moved"
              ? t.moved
              : event.action === "note.deleted"
                ? t.deleted
                : t.changed;
  return {
    id: event.id,
    at: event.lastOccurredAt,
    ref: event.note ? { type: "notebooks.note" as const, id: event.note.shortId } : null,
    title: event.note ? event.note.title.slice(0, 500) : null,
    actor: { type: event.actor.kind, id: event.actor.id, name: actor },
    icon: event.action === "note.created" ? "ti ti-plus" : "ti ti-pencil",
    sentence: describe(words),
    count: event.occurrenceCount,
  };
};
