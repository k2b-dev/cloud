import { type DateContext, dates, i18n } from "@k2b/stdlib";
import { formatDeadline } from "../presentation/deadline";
import type { SpaceActivityEvent, SpaceActivityIdentity } from "./activity";

type Words = { actor: string; self: boolean; kind: "task" | "event"; value: string };
export const activityTimelineMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      you: "You",
      system: "System",
      formerUser: "Former user",
      formerService: "Former service account",
      changed: ({ actor, kind }: Words) => `${actor} changed the ${kind}`,
      created: ({ actor, kind }: Words) => `${actor} created the ${kind}`,
      completed: ({ actor, kind }: Words) => `${actor} completed the ${kind}`,
      reopened: ({ actor, kind }: Words) => `${actor} reopened the ${kind}`,
      status: ({ actor, value }: Words) => `${actor} set the status to “${value}”`,
      deadline: ({ actor, value }: Words) => `${actor} set the due date to ${value}`,
      deadlineRemoved: ({ actor }: Words) => `${actor} removed the due date`,
      schedule: ({ actor, value }: Words) => `${actor} moved the event to ${value}`,
      description: ({ actor }: Words) => `${actor} changed the description`,
      title: ({ actor }: Words) => `${actor} changed the title`,
      priority: ({ actor }: Words) => `${actor} changed the priority`,
      assignees: ({ actor, kind }: Words) => `${actor} changed the ${kind}'s assignees`,
      assignedToYou: ({ actor, kind }: Words) => `${actor} assigned the ${kind} to you`,
      unassignedYou: ({ actor, kind }: Words) => `${actor} unassigned you from the ${kind}`,
      attached: ({ actor, value }: Words) => `${actor} attached “${value}”`,
      detached: ({ actor, value }: Words) => `${actor} removed “${value}”`,
      checklist: ({ actor }: Words) => `${actor} changed the checklist`,
      checklistCompleted: ({ actor }: Words) => `${actor} checked a checklist entry`,
      checklistReopened: ({ actor }: Words) => `${actor} unchecked a checklist entry`,
    },
    de: {
      you: "Du",
      system: "System",
      formerUser: "Ehemaliger Benutzer",
      formerService: "Ehemaliges Dienstkonto",
      changed: ({ actor, self, kind }: Words) =>
        `${actor} ${self ? "hast" : "hat"} ${kind === "task" ? "die Aufgabe" : "den Termin"} geändert`,
      created: ({ actor, self, kind }: Words) =>
        `${actor} ${self ? "hast" : "hat"} ${kind === "task" ? "die Aufgabe" : "den Termin"} erstellt`,
      completed: ({ actor, self, kind }: Words) =>
        `${actor} ${self ? "hast" : "hat"} ${kind === "task" ? "die Aufgabe erledigt" : "den Termin abgeschlossen"}`,
      reopened: ({ actor, self, kind }: Words) =>
        `${actor} ${self ? "hast" : "hat"} ${kind === "task" ? "die Aufgabe" : "den Termin"} wieder geöffnet`,
      status: ({ actor, self, value }: Words) => `${actor} ${self ? "hast" : "hat"} den Status auf „${value}“ gesetzt`,
      deadline: ({ actor, self, value }: Words) => `${actor} ${self ? "hast" : "hat"} die Fälligkeit auf ${value} gesetzt`,
      deadlineRemoved: ({ actor, self }: Words) => `${actor} ${self ? "hast" : "hat"} die Fälligkeit entfernt`,
      schedule: ({ actor, self, value }: Words) => `${actor} ${self ? "hast" : "hat"} den Termin auf ${value} verschoben`,
      description: ({ actor, self }: Words) => `${actor} ${self ? "hast" : "hat"} die Beschreibung geändert`,
      title: ({ actor, self }: Words) => `${actor} ${self ? "hast" : "hat"} den Titel geändert`,
      priority: ({ actor, self }: Words) => `${actor} ${self ? "hast" : "hat"} die Priorität geändert`,
      assignees: ({ actor, self, kind }: Words) =>
        `${actor} ${self ? "hast" : "hat"} die Zuständigkeiten ${kind === "task" ? "der Aufgabe" : "des Termins"} geändert`,
      assignedToYou: ({ actor, self, kind }: Words) =>
        `${actor} ${self ? "hast" : "hat"} dir ${kind === "task" ? "die Aufgabe" : "den Termin"} zugewiesen`,
      unassignedYou: ({ actor, self, kind }: Words) =>
        `${actor} ${self ? "hast" : "hat"} deine Zuweisung ${kind === "task" ? "zur Aufgabe" : "zum Termin"} entfernt`,
      attached: ({ actor, self, value }: Words) => `${actor} ${self ? "hast" : "hat"} „${value}“ angehängt`,
      detached: ({ actor, self, value }: Words) => `${actor} ${self ? "hast" : "hat"} „${value}“ entfernt`,
      checklist: ({ actor, self }: Words) => `${actor} ${self ? "hast" : "hat"} die Checkliste geändert`,
      checklistCompleted: ({ actor, self }: Words) => `${actor} ${self ? "hast" : "hat"} einen Checklistenpunkt abgehakt`,
      checklistReopened: ({ actor, self }: Words) => `${actor} ${self ? "hast" : "hat"} einen Checklistenpunkt wieder geöffnet`,
    },
  },
});

export const spaceActivityRow = (
  event: SpaceActivityEvent,
  options: { viewer: SpaceActivityIdentity; assigneeId: string; locale: string; timeZone: string },
) => {
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
  const words: Words = {
    actor: self ? t.you : actor,
    self,
    kind: event.item?.kind ?? (event.action.startsWith("event.") ? "event" : "task"),
    value: "",
  };
  const changed = Array.isArray(event.metadata.changed) ? event.metadata.changed : [];
  let sentence = t.changed(words);
  let icon = "ti ti-pencil";
  const dateConfig: DateContext = { locale: options.locale, timeZone: options.timeZone, weekStartsOn: 1 };
  const date = (value: unknown, allDay = false) =>
    typeof value === "string" && Number.isFinite(Date.parse(value))
      ? formatDeadline(allDay ? dates.formatDateKey(value, dateConfig) : value, dateConfig)
      : null;
  const assignees = event.action === "item.assignees.updated" ? event.metadata : event.metadata.assignees;
  if (event.action === "task.created" || event.action === "event.created") {
    sentence = t.created(words);
    icon = "ti ti-plus";
  } else if (event.action === "task.completed" || event.action === "event.completed") {
    sentence = t.completed(words);
    icon = "ti ti-check";
  } else if (event.action === "task.reopened" || event.action === "event.reopened") {
    sentence = t.reopened(words);
    icon = "ti ti-arrow-back-up";
  } else if ((event.action === "item.moved" || changed.includes("columnId")) && typeof event.metadata.columnName === "string") {
    sentence = t.status({ ...words, value: event.metadata.columnName });
    icon = "ti ti-columns";
  } else if (changed.includes("deadline") && event.metadata.deadline === null) {
    sentence = t.deadlineRemoved(words);
    icon = "ti ti-calendar-off";
  } else if (changed.includes("deadline") && date(event.metadata.deadline)) {
    sentence = t.deadline({ ...words, value: date(event.metadata.deadline)! });
    icon = "ti ti-calendar-due";
  } else if (
    (changed.includes("startsAt") || changed.includes("endsAt") || changed.includes("allDay")) &&
    date(event.metadata.startsAt ?? event.metadata.endsAt, event.metadata.allDay === true)
  ) {
    sentence = t.schedule({ ...words, value: date(event.metadata.startsAt ?? event.metadata.endsAt, event.metadata.allDay === true)! });
    icon = "ti ti-calendar-event";
  } else if (
    (event.action === "attachment.added" || event.action === "attachment.deleted") &&
    typeof event.metadata.filename === "string"
  ) {
    sentence = (event.action === "attachment.added" ? t.attached : t.detached)({ ...words, value: event.metadata.filename });
    icon = "ti ti-paperclip";
  } else if (
    ["checklist.created", "checklist.updated", "checklist.deleted", "checklist.completed", "checklist.reopened"].includes(event.action)
  ) {
    sentence = (
      event.action === "checklist.completed"
        ? t.checklistCompleted
        : event.action === "checklist.reopened"
          ? t.checklistReopened
          : t.checklist
    )(words);
    icon = "ti ti-list-check";
  } else if (assignees && typeof assignees === "object") {
    const added = "added" in assignees && Array.isArray(assignees.added) ? assignees.added : [];
    const removed = "removed" in assignees && Array.isArray(assignees.removed) ? assignees.removed : [];
    sentence = (
      added.includes(options.assigneeId) ? t.assignedToYou : removed.includes(options.assigneeId) ? t.unassignedYou : t.assignees
    )(words);
    icon = "ti ti-user-check";
  } else if (changed.includes("description")) sentence = t.description(words);
  else if (changed.includes("title")) sentence = t.title(words);
  else if (changed.includes("priority")) sentence = t.priority(words);
  return {
    id: event.id,
    at: event.lastOccurredAt,
    ref: event.item ? { type: "spaces.item" as const, id: event.item.shortId } : null,
    title: event.item ? event.item.title.slice(0, 500) : null,
    actor: { type: event.actor.kind, id: event.actor.id, name: actor },
    icon,
    sentence,
    count: event.occurrenceCount,
  };
};
