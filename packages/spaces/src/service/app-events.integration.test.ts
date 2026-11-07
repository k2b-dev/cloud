import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import type { AppEventEnvelope } from "@k2b/cloud/events";
import { appEventFixture, deliverAppEvent } from "@k2b/cloud/events/testing";
import { databaseSuite, testInfra } from "../../../../scripts/fixtures/test-infra";
import * as producer from "../app-events";
import { spacesCapabilities } from "../capabilities";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import * as items from "./items";
import { publishSpaceChange } from "./live";
import * as wormholes from "./wormholes";

const suite = databaseSuite();
const spaceIds: string[] = [];
const userIds: string[] = [];
const accessIds: string[] = [];
let owner: CapabilityExecutionContext;
let other: CapabilityExecutionContext;
const context = (id: string): CapabilityExecutionContext => {
  const user: User = {
    id,
    uid: id,
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Private",
    sn: "Name",
    displayName: "Private Name",
    mail: "private@example.test",
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  };
  return {
    user,
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: id },
    requestId: "events-test",
    origin: "app",
    locale: "en",
    signal: new AbortController().signal,
  };
};
beforeEach(() => setSystemTime(new Date("2026-10-27T12:00:00Z")));
afterEach(() => setSystemTime());
beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  for (let i = 0; i < 2; i++) {
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile)
      VALUES (${`producer-${crypto.randomUUID()}`}, 'local', 'user') RETURNING id`;
    userIds.push(user!.id);
  }
  owner = context(userIds[0]!);
  other = context(userIds[1]!);
});
afterAll(async () => {
  if (!testInfra.database) return;
  for (const id of spaceIds) {
    const [space] = await sql<{ short_id: string }[]>`SELECT short_id FROM spaces.spaces WHERE id = ${id}::uuid`;
    await sql`DELETE FROM events.outbox WHERE app_id = 'spaces' AND
      (ordering_key = ${id} OR payload->'place'->>'id' = ${space?.short_id ?? ""})`;
    await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
  }
  for (const id of accessIds) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
  for (const id of userIds) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
});
const board = async (grantOther = false) => {
  const [space] = await sql<{ id: string; short_id: string }[]>`INSERT INTO spaces.spaces(short_id, name)
    VALUES (${newShortId()}, 'Secret space name') RETURNING id, short_id`;
  spaceIds.push(space!.id);
  for (const userId of grantOther ? userIds : [userIds[0]!]) {
    const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id, permission)
      VALUES (${userId}::uuid, ${userId === userIds[0] ? "admin" : "read"}) RETURNING id`;
    accessIds.push(access!.id);
    await sql`INSERT INTO spaces.space_access(space_id, access_id) VALUES (${space!.id}::uuid, ${access!.id}::uuid)`;
  }
  const [open] = await sql<{ id: string }[]>`INSERT INTO spaces.columns(short_id, space_id, name, rank)
    VALUES (${newShortId()}, ${space!.id}::uuid, 'Secret open', 1024) RETURNING id`;
  const [done] = await sql<{ id: string }[]>`INSERT INTO spaces.columns(short_id, space_id, name, rank, is_done)
    VALUES (${newShortId()}, ${space!.id}::uuid, 'Secret done', 2048, true) RETURNING id`;
  return { ...space!, open: open!.id, done: done!.id };
};
const create = async (space: Awaited<ReturnType<typeof board>>) => {
  const result = await items.create({
    spaceId: space.id,
    data: { columnId: space.open, title: "Secret task", description: "Secret text" },
    createdBy: userIds[0]!,
  });
  if (!result.ok) throw new Error(result.error);
  const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM spaces.items WHERE id = ${result.data.id}::uuid`;
  return { ...result.data, shortId: row!.short_id };
};
const pending = async (shortId: string): Promise<AppEventEnvelope[]> =>
  (
    await sql<{ payload: AppEventEnvelope }[]>`SELECT payload FROM events.outbox WHERE app_id = 'spaces'
    AND kind = 'event' AND payload->'place'->>'id' = ${shortId} ORDER BY seq`
  ).map((row) => row.payload);
const assertThin = (event: AppEventEnvelope) => {
  expect(Object.keys(event).sort()).toEqual(["data", "id", "place", "source", "subject", "time", "type", "version"]);
  expect(Object.keys(event.data && typeof event.data === "object" ? event.data : { invalid: true })).toEqual([]);
  expect(event.data).toEqual({});
  expect(event.version).toBe(1);
  expect(event.source).toBe("spaces");
  expect(Object.keys(event.subject).sort()).toEqual(["id", "type"]);
  expect(Object.keys(event.place!).sort()).toEqual(["id", "type"]);
};
suite("Spaces declared resource event producers", () => {
  test("creation and completion publish public refs; repeated completion and reopening publish nothing", async () => {
    const space = await board();
    const item = await create(space);
    expect((await items.setCompleted({ id: item.id, completed: true })).ok).toBe(true);
    expect((await items.setCompleted({ id: item.id, completed: true })).ok).toBe(true);
    expect((await items.setCompleted({ id: item.id, completed: false })).ok).toBe(true);
    const events = await pending(space.short_id);
    expect(events.map((e) => e.type)).toEqual(["spaces.item.created", "spaces.item.completed"]);
    for (const event of events) {
      assertThin(event);
      await expect(deliverAppEvent(spacesCapabilities, event.type, event, { appId: "spaces" })).rejects.toThrow(
        "resource_events_unsupported",
      );
      expect(event.subject).toEqual({ type: "spaces.item", id: item.shortId });
      expect(event.place).toEqual({ type: "spaces.space", id: space.short_id });
      const place = spacesCapabilities.queries["space.read"];
      const subject = spacesCapabilities.queries["item.read"];
      expect((await place.run(place.input.parse({ id: event.place!.id }), owner)).ok).toBe(true);
      expect((await subject.run(subject.input.parse({ id: event.subject.id }), owner)).ok).toBe(true);
      expect((await place.run(place.input.parse({ id: event.place!.id }), other)).ok).toBe(false);
      expect((await subject.run(subject.input.parse({ id: event.subject.id }), other)).ok).toBe(false);
    }
    for (const [name, declaration] of Object.entries(producer.spacesEvents)) {
      const fixture = appEventFixture(spacesCapabilities, name as keyof typeof producer.spacesEvents, {
        subject: item.shortId,
        place: space.short_id,
        data: {},
      });
      expect(Buffer.byteLength(JSON.stringify(fixture))).toBe(name === "item.created" ? 241 : 243);
      expect(declaration.schema.safeParse({ title: "hidden" }).success).toBe(false);
      expect(declaration.subject).toBe("item");
      expect(declaration.place).toBe("space");
    }
    expect(spacesCapabilities.types.space.reader).toBe("space.read");
  });
  test("dragging into done completes once; transferring into done publishes only at the new place", async () => {
    const source = await board(true);
    const target = await board();
    const item = await create(source);
    expect((await items.move({ id: item.id, columnId: source.done })).ok).toBe(true);
    expect((await items.move({ id: item.id, columnId: source.done })).ok).toBe(true);
    expect((await items.move({ id: item.id, columnId: source.open })).ok).toBe(true);
    const itemReader = spacesCapabilities.queries["item.read"];
    expect((await itemReader.run(itemReader.input.parse({ id: item.shortId }), other)).ok).toBe(true);
    const actor = { subject: owner.accessSubject, resourceBoundSpaceId: null };
    const hole = await wormholes.create({ sourceSpaceId: source.id, data: { targetColumnId: target.done, color: "#6366f1" }, actor });
    expect(hole.ok).toBe(true);
    if (!hole.ok) throw new Error(hole.error);
    const before = await pending(source.short_id);
    expect((await wormholes.transfer({ sourceSpaceId: source.id, itemId: item.id, wormholeId: hole.data.id, actor })).ok).toBe(true);
    expect(await pending(source.short_id)).toEqual(before);
    const destination = await pending(target.short_id);
    expect(destination.map((e) => e.type)).toEqual(["spaces.item.completed"]);
    assertThin(destination[0]!);
    expect(JSON.stringify(await pending(source.short_id))).not.toContain(target.short_id);
    const read = spacesCapabilities.queries["space.read"];
    expect((await read.run(read.input.parse({ id: target.short_id }), other)).ok).toBe(false);
    expect((await itemReader.run(itemReader.input.parse({ id: item.shortId }), other)).ok).toBe(false);
  });
  test("calendar cancellation publishes only its transition into done", async () => {
    const space = await board();
    const eventId = await sql.begin(async (tx) => {
      const event = await items.persistCalendarEvent({
        db: tx,
        spaceId: space.id,
        itemId: null,
        createdBy: userIds[0]!,
        completed: false,
        shortId: newShortId(),
        data: {
          title: "Private meeting",
          description: "hidden",
          location: null,
          url: null,
          startsAt: "2026-10-27T10:00:00Z",
          endsAt: "2026-10-27T11:00:00Z",
          allDay: false,
          recurrenceRule: null,
        },
      });
      if (!event.ok) throw new Error(event.error);
      await producer.publishItemEvent(tx, "item.created", event.data.id, space.id);
      await publishSpaceChange(tx, { type: "item.created", spaceId: space.id, itemId: event.data.id });
      return event.data.id;
    });
    for (let n = 0; n < 2; n++)
      await sql.begin((tx) =>
        items.persistCalendarEvent({
          db: tx,
          spaceId: space.id,
          itemId: eventId,
          createdBy: userIds[0]!,
          completed: true,
          shortId: newShortId(),
          data: {
            title: "Cancelled",
            description: null,
            location: null,
            url: null,
            startsAt: "2026-10-27T10:00:00Z",
            endsAt: "2026-10-27T11:00:00Z",
            allDay: false,
            recurrenceRule: null,
          },
        }),
      );
    expect((await pending(space.short_id)).map((e) => e.type)).toEqual(["spaces.item.created", "spaces.item.completed"]);
  });
  test("stored recurrence overrides and a split series each publish creation once", async () => {
    const space = await board();
    const series = await items.create({
      spaceId: space.id,
      data: {
        columnId: space.open,
        title: "Private series",
        startsAt: "2026-10-27T10:00:00Z",
        endsAt: "2026-10-27T11:00:00Z",
        recurrence: { rrule: "FREQ=DAILY;COUNT=5", dtstart: "2026-10-27T10:00:00Z", exdate: [] },
      },
      createdBy: userIds[0]!,
      dateConfig: { timeZone: "UTC", locale: "en", firstDayOfWeek: 1 },
    });
    if (!series.ok) throw new Error(series.error);
    const override = {
      spaceId: space.id,
      data: {
        columnId: space.open,
        title: "Private override",
        startsAt: "2026-10-28T10:00:00Z",
        endsAt: "2026-10-28T11:00:00Z",
        recurringEventId: series.data.id,
        recurrenceId: "2026-10-28T10:00:00Z",
      },
      createdBy: userIds[0]!,
      dateConfig: { timeZone: "UTC", locale: "en", firstDayOfWeek: 1 as const },
    };
    expect((await items.create(override)).ok).toBe(true);
    expect((await items.create(override)).ok).toBe(false);
    const split = await items.splitRecurring({
      id: series.data.id,
      data: { recurrenceId: "2026-10-29T10:00:00Z", startsAt: "2026-10-29T10:00:00Z", endsAt: "2026-10-29T11:00:00Z", allDay: false },
      createdBy: userIds[0]!,
      dateConfig: { timeZone: "UTC", locale: "en", firstDayOfWeek: 1 },
    });
    expect(split.ok).toBe(true);
    expect((await pending(space.short_id)).map((e) => e.type)).toEqual([
      "spaces.item.created",
      "spaces.item.created",
      "spaces.item.created",
    ]);
  });
  test("an outbox failure rolls back creation and completion together with the event", async () => {
    const space = await board();
    const item = await create(space);
    const original = producer.publishSpacesEvent;
    const failure = spyOn(producer, "publishSpacesEvent").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("producer rollback");
    });
    try {
      await expect(create(space)).rejects.toThrow("producer rollback");
      await expect(items.setCompleted({ id: item.id, completed: true })).rejects.toThrow("producer rollback");
    } finally {
      failure.mockRestore();
    }
    expect((await pending(space.short_id)).map((e) => e.type)).toEqual(["spaces.item.created"]);
    expect((await items.get({ id: item.id }))!.completedAt).toBeNull();
    expect(
      (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM spaces.items WHERE space_id = ${space.id}::uuid`)[0]!.count,
    ).toBe(1);
  });
});
