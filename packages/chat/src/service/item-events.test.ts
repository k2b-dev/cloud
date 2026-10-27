import { expect, test } from "bun:test";
import { ItemEventSchema, ItemEventsPageSchema, ItemEventsQuerySchema } from "./contracts";
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
    thread: { ref: event.ref, name: "" },
  });
  expect(mapItemEvent({ ...event, title: "Invitation" }).thread).toEqual({ ref: event.ref, name: "Invitation" });
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

test("preserves optional owner links through the public event page", () => {
  const href = "/app/notebooks/Ntb001/notes/Nte001?annotation=11111111-1111-4111-8111-111111111111";
  const [owner] = OwnerActivitySchema.parse([{ ...event, href }]);
  const item = mapItemEvent({ ...owner!, ref: event.ref });
  expect(ItemEventsPageSchema.parse({ items: [item], nextCursor: null }).items[0]?.href).toBe(href);
  expect(mapItemEvent(event)).not.toHaveProperty("href");
});

test.each([
  "https://example.invalid/passage",
  "//example.invalid/passage",
  "javascript:alert(1)",
  "/\\example.invalid/passage",
  "/path\\passage",
  "/path\npassage",
  "relative/path",
  "",
  `/${"x".repeat(2048)}`,
])("rejects invalid activity links at both owner and browser transport boundaries: %j", (href) => {
  expect(OwnerActivitySchema.safeParse([{ ...event, href }]).success).toBeFalse();
  expect(ItemEventSchema.safeParse({ ...mapItemEvent(event), href }).success).toBeFalse();
});
