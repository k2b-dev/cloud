import { expect, test } from "bun:test";
import type { NotebookActivityEvent } from "./activity";
import { notebookActivityRow } from "./activity-timeline";

const event: NotebookActivityEvent = {
  id: "1",
  notebook: { id: "notebook", shortId: "Ntb001", name: "Project", icon: null },
  note: { id: "note", shortId: "Nte001", title: "Do not repeat this title" },
  noteVersionId: null,
  actor: { kind: "user", id: "lena", displayName: "Lena", avatarHash: null },
  action: "note.edited",
  metadata: {},
  occurrenceCount: 4,
  createdAt: "2026-10-23T12:00:00Z",
  lastOccurredAt: "2026-10-23T12:30:00Z",
};
const options = { viewer: { kind: "user" as const, id: "me" }, locale: "en" };
test("formats one row per bucket, actor first, with English and German self forms", () => {
  expect(notebookActivityRow(event, options)).toMatchObject({
    sentence: "Lena edited the note",
    count: 4,
    id: "1",
    at: event.lastOccurredAt,
    ref: { type: "notebooks.note", id: "Nte001" },
  });
  expect(notebookActivityRow(event, { ...options, locale: "de" }).sentence).toBe("Lena hat die Notiz bearbeitet");
  const self = { ...event, actor: { ...event.actor, id: "me" } };
  expect(notebookActivityRow(self, options).sentence).toBe("You edited the note");
  expect(notebookActivityRow(self, { ...options, locale: "de" }).sentence).toBe("Du hast die Notiz bearbeitet");
  expect(notebookActivityRow({ ...event, action: "old.unknown" }, options).sentence).toBe("Lena changed the note");
});
test.each(["created", "renamed", "moved", "deleted"])("formats recorded note.%s actions", (action) => {
  expect(notebookActivityRow({ ...event, action: `note.${action}` }, options).sentence).toBe(`Lena ${action} the note`);
});
