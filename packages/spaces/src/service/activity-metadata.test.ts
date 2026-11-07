import { expect, test } from "bun:test";
import { assigneeChangeMetadata, itemChangeMetadata } from "./activity-metadata";

const before: Parameters<typeof itemChangeMetadata>[0] = {
  columnId: "column",
  title: "Before",
  description: "Old private content",
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  estimatedDurationMinutes: null,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
};
test("records changed field names and presentation dates without copying text", () => {
  const metadata = itemChangeMetadata(before, {
    ...before,
    title: "New title",
    description: "New private content",
    deadline: "2026-10-23",
  });
  expect(metadata).toEqual({ changed: ["title", "description", "deadline"], deadline: "2026-10-23" });
  expect(JSON.stringify(metadata)).not.toContain("private content");
  expect(JSON.stringify(metadata)).not.toContain("New title");
  expect(itemChangeMetadata(before, before)).toEqual({ changed: [] });
});
test("records removed dates and all-day schedule facts", () => {
  expect(itemChangeMetadata({ ...before, deadline: "2026-10-23" }, before)).toEqual({ changed: ["deadline"], deadline: null });
  expect(itemChangeMetadata({ ...before, allDay: true }, { ...before, allDay: true, startsAt: "2026-10-24T00:00:00Z" })).toEqual({
    changed: ["startsAt"],
    startsAt: "2026-10-24T00:00:00Z",
    allDay: true,
  });
});
test("records only added and removed principals", () => {
  expect(assigneeChangeMetadata([{ id: "retained" }, { id: "removed" }], [{ id: "added" }, { id: "retained" }])).toEqual({
    added: ["added"],
    removed: ["removed"],
  });
});
