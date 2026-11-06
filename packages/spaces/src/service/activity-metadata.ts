import type { SpaceItem } from "../contracts";

type Fields = Pick<
  SpaceItem,
  | "columnId"
  | "title"
  | "description"
  | "location"
  | "url"
  | "startsAt"
  | "endsAt"
  | "allDay"
  | "deadline"
  | "estimatedDurationMinutes"
  | "priority"
  | "recurrence"
  | "recurringEventId"
  | "recurrenceId"
>;
const fields = [
  "columnId",
  "title",
  "description",
  "location",
  "url",
  "startsAt",
  "endsAt",
  "allDay",
  "deadline",
  "estimatedDurationMinutes",
  "priority",
  "recurrence",
  "recurringEventId",
  "recurrenceId",
] as const;

/** Presentation facts only: never copy description content or the new title. */
export const itemChangeMetadata = (before: Fields, after: Fields): Record<string, unknown> => {
  const changed = fields.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
  return {
    changed,
    ...(changed.includes("allDay") ? { startsAt: after.startsAt, endsAt: after.endsAt } : {}),
    ...(changed.some((field) => field === "startsAt" || field === "endsAt") ? { allDay: after.allDay } : {}),
    ...Object.fromEntries(
      (["deadline", "startsAt", "endsAt", "allDay"] as const)
        .filter((field) => changed.includes(field))
        .map((field) => [field, after[field]]),
    ),
  };
};

export const assigneeChangeMetadata = (before: readonly { id: string }[], after: readonly { id: string }[]) => ({
  added: after.filter((principal) => !before.some((old) => old.id === principal.id)).map((principal) => principal.id),
  removed: before.filter((principal) => !after.some((next) => next.id === principal.id)).map((principal) => principal.id),
});
