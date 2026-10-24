import { expect, test } from "bun:test";
import { ItemEventsQuerySchema } from "./contracts";
import { activityQuery, mapItemEvent, OwnerActivitySchema } from "./item-events";

const event = {
  id: "4",
  at: "2026-10-23T10:00:00Z",
  ref: { type: "spaces.item" as const, id: "Itm001" },
  actor: { type: "user" as const, id: "11111111-1111-4111-8111-111111111111", name: "Mara" },
  icon: "ti ti-check",
  sentence: "Mara completed the task",
  count: 3,
};
test("maps an owner event to the existing thread or an openable resource, without copying actor data", () => {
  expect(mapItemEvent(event)).toEqual({
    id: "4",
    at: event.at,
    icon: event.icon,
    sentence: event.sentence,
    count: 3,
    thread: { ref: event.ref },
  });
  expect(mapItemEvent(event, { id: "Thr001", name: "Current title" }).thread).toEqual({ id: "Thr001", name: "Current title" });
});
test("maps container and item selection, independent time bounds and opaque cursors", () => {
  const query = ItemEventsQuerySchema.parse({
    after: "2026-10-22T00:00:00Z",
    before: "2026-10-24T00:00:00Z",
    limit: "100",
    cursor: "opaque",
  });
  expect(activityQuery({ type: "spaces.space", id: "Spc001" }, query, event.ref, "Europe/Berlin")).toEqual({
    appId: "spaces",
    capabilityId: "space.activity",
    input: {
      space: "Spc001",
      item: "Itm001",
      timeZone: "Europe/Berlin",
      before: query.before,
      after: query.after,
      cursor: "opaque",
      limit: 100,
    },
  });
  expect(activityQuery({ type: "notebooks.notebook", id: "Ntb001" }, ItemEventsQuerySchema.parse({}))).toEqual({
    appId: "notebooks",
    capabilityId: "notebook.activity",
    input: { notebook: "Ntb001", before: undefined, after: undefined, cursor: undefined, limit: 50 },
  });
});
test("bounds every page and rejects invalid provider rows", () => {
  for (const input of [
    { limit: 101 },
    { limit: 0 },
    { limit: 1.5 },
    { cursor: "x".repeat(257) },
    { before: "yesterday" },
    { thread: "general" },
  ])
    expect(ItemEventsQuerySchema.safeParse(input).success).toBeFalse();
  expect(OwnerActivitySchema.parse([event])).toEqual([event]);
  expect(OwnerActivitySchema.safeParse(Array.from({ length: 101 }, () => event)).success).toBeFalse();
  expect(OwnerActivitySchema.safeParse([{ ...event, ref: { type: "spaces.space", id: "Spc001" } }]).success).toBeFalse();
  expect(OwnerActivitySchema.safeParse([{ ...event, icon: "arbitrary-class" }]).success).toBeFalse();
});
