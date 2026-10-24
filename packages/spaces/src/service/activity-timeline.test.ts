import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { SpaceActivityEvent } from "./activity";
import { spaceActivityRow } from "./activity-timeline";

const event: SpaceActivityEvent = {
  id: "1",
  space: { id: "space", shortId: "Spc001", name: "Project", color: "blue" },
  item: { id: "item", shortId: "Itm001", title: "Never repeat this title", kind: "task" },
  actor: { kind: "user", id: "mara", displayName: "Mara", avatarHash: null },
  action: "task.updated",
  metadata: {},
  occurrenceCount: 3,
  createdAt: "2026-10-23T12:00:00Z",
  lastOccurredAt: "2026-10-23T12:30:00Z",
};
const options = { viewer: { kind: "user" as const, id: "me" }, assigneeId: "me", locale: "en", timeZone: "Europe/Berlin" };
beforeEach(() => setSystemTime(new Date("2026-10-24T12:00:00Z")));
afterEach(() => setSystemTime());
test("formats actor-first status, self forms and bucket identity without item titles", () => {
  const moved = { ...event, action: "item.moved", metadata: { columnName: "In review" } };
  expect(spaceActivityRow(moved, options)).toMatchObject({
    id: "1",
    at: event.lastOccurredAt,
    count: 3,
    sentence: "Mara set the status to “In review”",
    ref: { type: "spaces.item", id: "Itm001" },
  });
  expect(spaceActivityRow({ ...moved, actor: { ...event.actor, id: "me" } }, options).sentence).toBe("You set the status to “In review”");
  expect(spaceActivityRow(moved, { ...options, locale: "de" }).sentence).toBe("Mara hat den Status auf „In review“ gesetzt");
  expect(spaceActivityRow({ ...moved, actor: { ...event.actor, id: "me" } }, { ...options, locale: "de" }).sentence).toBe(
    "Du hast den Status auf „In review“ gesetzt",
  );
});
test("formats assignment to the viewer, attachments, checklist and neutral old actions", () => {
  const assigned = { ...event, action: "item.assignees.updated", metadata: { added: ["me"], removed: [] } };
  expect(spaceActivityRow(assigned, options).sentence).toBe("Mara assigned the task to you");
  expect(spaceActivityRow(assigned, { ...options, locale: "de" }).sentence).toBe("Mara hat dir die Aufgabe zugewiesen");
  expect(spaceActivityRow({ ...event, action: "attachment.added", metadata: { filename: "Raumplan-v3.pdf" } }, options).sentence).toBe(
    "Mara attached “Raumplan-v3.pdf”",
  );
  expect(spaceActivityRow({ ...event, action: "checklist.completed" }, options).sentence).toBe("Mara checked a checklist entry");
  expect(spaceActivityRow({ ...event, action: "task.completed" }, options).sentence).toBe("Mara completed the task");
  expect(spaceActivityRow({ ...event, action: "unknown.old" }, { ...options, locale: "de" }).sentence).toBe(
    "Mara hat die Aufgabe geändert",
  );
  expect(spaceActivityRow(event, options).sentence).toBe("Mara changed the task");
});
test("formats date-only deadlines independently of timezone and schedule instants in the viewer's zone", () => {
  const due = { ...event, metadata: { changed: ["deadline"], deadline: "2026-10-23" } };
  expect(spaceActivityRow(due, { ...options, timeZone: "America/Los_Angeles" }).sentence).toBe("Mara set the due date to Fri, Oct 23");
  expect(spaceActivityRow(due, { ...options, locale: "de" }).sentence).toBe("Mara hat die Fälligkeit auf Fr., 23. Okt. gesetzt");
  const scheduled = { ...event, metadata: { changed: ["startsAt"], startsAt: "2026-10-22T16:00:00Z" } };
  expect(spaceActivityRow(scheduled, options).sentence).toContain("18:00");
  expect(spaceActivityRow(scheduled, { ...options, timeZone: "UTC" }).sentence).toContain("16:00");
  expect(spaceActivityRow({ ...event, metadata: { changed: ["deadline"], deadline: null } }, options).sentence).toBe(
    "Mara removed the due date",
  );
});

test("formats all-day schedules in the caller's local calendar", () => {
  const scheduled = { ...event, metadata: { changed: ["startsAt"], startsAt: "2026-10-22T22:00:00Z", allDay: true } };
  expect(spaceActivityRow(scheduled, options).sentence).toBe("Mara moved the event to Fri, Oct 23");
});
