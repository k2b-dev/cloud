import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import type { AppEventEnvelope } from "@k2b/cloud/events";
import { appEventFixture, deliverAppEvent } from "@k2b/cloud/events/testing";
import { toPgUuidArray } from "@k2b/cloud/services";
import * as settings from "@k2b/cloud/services/settings";
import { databaseSuite, testInfra, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import * as producer from "../app-events";
import { spacesCapabilities } from "../capabilities";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import * as comments from "./comments";
import { ITEM_DUE_BATCH, sweepDueItems } from "./item-due-events";
import * as items from "./items";
import { publishSpaceChange } from "./live";
import * as taskWork from "./task-work";
import * as wormholes from "./wormholes";

const suite = databaseSuite();
const spaceIds: string[] = [];
const userIds: string[] = [];
const accessIds: string[] = [];
let database: Awaited<ReturnType<typeof useMigratedDatabase>> | undefined;
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
afterEach(() => {
  setSystemTime();
  mock.restore();
});
beforeAll(async () => {
  if (!testInfra.database) return;
  database = await useMigratedDatabase("spaces_events");
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
  await database?.drop();
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
  if (event.type === "spaces.item.updated") {
    expect(producer.spacesEvents["item.updated"].schema.safeParse(event.data).success).toBe(true);
  } else expect(event.data).toEqual({});
  expect(event.version).toBe(1);
  expect(event.source).toBe("spaces");
  expect(Object.keys(event.subject).sort()).toEqual(["id", "type"]);
  expect(Object.keys(event.place!).sort()).toEqual(["id", "type"]);
};
suite("Spaces declared resource event producers", () => {
  test("creation, completion and reopening publish public refs; repeated completion publishes nothing", async () => {
    const space = await board();
    const item = await create(space);
    expect((await items.setCompleted({ id: item.id, completed: true })).ok).toBe(true);
    expect((await items.setCompleted({ id: item.id, completed: true })).ok).toBe(true);
    expect((await items.setCompleted({ id: item.id, completed: false })).ok).toBe(true);
    const events = await pending(space.short_id);
    expect(events.map((e) => e.type)).toEqual([
      "spaces.item.created",
      "spaces.item.updated",
      "spaces.item.completed",
      "spaces.item.updated",
    ]);
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
        data: name === "item.updated" ? { changed: ["assignees", "due", "status"] } : {},
      });
      expect(Buffer.byteLength(JSON.stringify(fixture))).toBeLessThan(350);
      expect(declaration.schema.safeParse({ title: "hidden" }).success).toBe(false);
      expect(declaration.subject).toBe(name === "comment.created" ? "comment" : "item");
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
    expect(destination.map((e) => e.type)).toEqual(["spaces.item.updated", "spaces.item.completed"]);
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
    expect((await pending(space.short_id)).map((e) => e.type)).toEqual([
      "spaces.item.created",
      "spaces.item.updated",
      "spaces.item.completed",
    ]);
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
  test("comments announce only the new public comment ref, once on retry, and roll back with the outbox", async () => {
    const space = await board();
    const item = await create(space);
    const input = {
      requestId: crypto.randomUUID(),
      itemId: item.id,
      author: { kind: "user" as const, id: userIds[0]! },
      content: "Private comment",
    };
    expect((await comments.create(input)).ok).toBe(true);
    expect((await comments.create(input)).ok).toBe(true);
    const events = (await pending(space.short_id)).filter((e) => e.type === "spaces.comment.created");
    expect(events).toHaveLength(1);
    assertThin(events[0]!);
    expect(events[0]!.subject.type).toBe("spaces.comment");
    expect(events[0]!.place).toEqual({ type: "spaces.space", id: space.short_id });
    const reader = spacesCapabilities.queries["comment.read"];
    expect((await reader.run(reader.input.parse({ id: events[0]!.subject.id }), owner)).ok).toBe(true);
    expect((await reader.run(reader.input.parse({ id: events[0]!.subject.id }), other)).ok).toBe(false);
    const original = producer.publishSpacesEvent;
    const failure = spyOn(producer, "publishSpacesEvent").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("rollback");
    });
    const failedId = crypto.randomUUID();
    try {
      await expect(comments.create({ ...input, requestId: failedId })).rejects.toThrow("rollback");
    } finally {
      failure.mockRestore();
    }
    expect(await comments.get({ id: failedId })).toBeNull();
    expect((await pending(space.short_id)).filter((e) => e.type === "spaces.comment.created")).toEqual(events);
  });

  test("updates list only changed assignees, due and status; normalized no-ops and unrelated edits stay quiet", async () => {
    const space = await board(true);
    const item = await create(space);
    const change = async (data: Parameters<typeof items.update>[0]["data"]) => {
      expect((await items.update({ id: item.id, data })).ok).toBe(true);
    };
    await change({ title: "New title", description: "Secret body", priority: "high" });
    await change({ assigneeIds: [userIds[0]!, userIds[1]!], deadline: "2026-10-27T14:00:00Z" });
    const first = (await pending(space.short_id)).filter((e) => e.type === "spaces.item.updated");
    expect(first.map((e) => e.data)).toEqual([{ changed: ["assignees", "due"] }]);
    await change({ assigneeIds: [userIds[1]!, userIds[0]!], deadline: "2026-10-27T15:00:00+01:00" });
    expect((await items.setAssignees({ id: item.id, userIds: [userIds[0]!, userIds[1]!] })).ok).toBe(true);
    expect((await pending(space.short_id)).filter((e) => e.type === "spaces.item.updated")).toEqual(first);
    expect((await items.setAssignees({ id: item.id, userIds: [] })).ok).toBe(true);
    await change({ columnId: space.done, deadline: "2026-10-28" });
    const updates = (await pending(space.short_id)).filter((e) => e.type === "spaces.item.updated");
    expect(updates.map((e) => e.data)).toEqual([
      { changed: ["assignees", "due"] },
      { changed: ["assignees"] },
      { changed: ["due", "status"] },
    ]);
    const original = producer.publishSpacesEvent;
    const failure = spyOn(producer, "publishSpacesEvent").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("rollback");
    });
    try {
      await expect(items.update({ id: item.id, data: { deadline: null, assigneeIds: [userIds[0]!] } })).rejects.toThrow("rollback");
    } finally {
      failure.mockRestore();
    }
    expect((await items.get({ id: item.id }))!.deadline).toBe("2026-10-28");
    expect((await pending(space.short_id)).filter((e) => e.type === "spaces.item.updated")).toEqual(updates);
  });

  test("claiming announces an added assignee once; claim retry, progress and ordinary release do not", async () => {
    const space = await board();
    const item = await create(space);
    const input = {
      itemId: item.id,
      spaceId: space.id,
      actor: { kind: "user" as const, id: userIds[0]! },
      subject: owner.accessSubject,
      claimId: crypto.randomUUID(),
    };
    for (const operation of ["claim", "claim", "progress", "release"] as const)
      expect(
        (await taskWork.change({ ...input, operation, ...(operation === "progress" ? { content: "Private progress" } : {}) })).ok,
      ).toBe(true);
    expect((await pending(space.short_id)).filter((e) => e.type === "spaces.item.updated").map((e) => e.data)).toEqual([
      { changed: ["assignees"] },
    ]);
  });

  test("due ticks skip pre-watermark deadlines, drain a 500-task burst, and stay bounded and idempotent after restart", async () => {
    const space = await board();
    const at = new Date("2026-10-27T12:00:00Z");
    const zone = spyOn(settings, "get").mockResolvedValue("Europe/Berlin");
    try {
      await sql`UPDATE spaces.app_event_sweep SET started_at = NULL, last_swept_at = NULL`;
      // Keep other producer tests' tasks out of this installation-wide tick.
      await sql`UPDATE spaces.items SET deadline = NULL, deadline_date = NULL WHERE space_id = ANY(${toPgUuidArray(spaceIds.filter((id) => id !== space.id))}::uuid[])`;
      const oldTimed = await create(space);
      const oldAllDay = await create(space);
      const atWatermark = await create(space);
      const watermark = new Date(at.getTime() - 60_000);
      await sql`UPDATE spaces.items SET deadline = ${new Date(watermark.getTime() - 1)} WHERE id = ${oldTimed.id}::uuid`;
      await sql`UPDATE spaces.items SET deadline = ${watermark} WHERE id = ${atWatermark.id}::uuid`;
      await sql`UPDATE spaces.items SET deadline_date = '2026-10-27'::date WHERE id = ${oldAllDay.id}::uuid`;
      // Seed more than one full batch in one statement, without hundreds of unrelated create events.
      const burst = Array.from({ length: ITEM_DUE_BATCH + 1 }, () => ({ short_id: newShortId() }));
      const due = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO spaces.items(short_id, space_id, column_id, title, deadline)
        SELECT input.short_id, ${space.id}::uuid, ${space.open}::uuid, 'Burst task', ${at}::timestamptz
        FROM jsonb_to_recordset(${JSON.stringify(burst)}::text::jsonb) AS input(short_id text)
        RETURNING id, short_id`;
      expect(due).toHaveLength(ITEM_DUE_BATCH + 1);
      expect(ITEM_DUE_BATCH).toBeGreaterThanOrEqual(500);
      expect(ITEM_DUE_BATCH * (4096 + 1024)).toBeLessThanOrEqual(0.01 * 256 * 1024 ** 2);
      const future = await create(space);
      await sql`UPDATE spaces.items SET deadline = ${new Date(at.getTime() + 60_000)} WHERE id = ${future.id}::uuid`;
      const completed = await create(space);
      await sql`UPDATE spaces.items SET deadline = ${at}, completed_at = ${at} WHERE id = ${completed.id}::uuid`;
      const done = await create(space);
      await sql`UPDATE spaces.items SET deadline = ${at}, column_id = ${space.done}::uuid WHERE id = ${done.id}::uuid`;
      const calendar = await create(space);
      await sql`UPDATE spaces.items SET deadline = ${at}, starts_at = ${at}, ends_at = ${new Date(at.getTime() + 60_000)} WHERE id = ${calendar.id}::uuid`;
      const allDay = await create(space);
      await sql`UPDATE spaces.items SET deadline_date = '2026-10-28'::date WHERE id = ${allDay.id}::uuid`;
      expect(await sweepDueItems(watermark)).toBe(0);
      expect((await pending(space.short_id)).filter((e) => e.type === "spaces.item.due")).toHaveLength(0);
      const [started] = await sql<{ started_at: Date }[]>`SELECT started_at FROM spaces.app_event_sweep`;
      expect(started!.started_at).toEqual(watermark);
      expect(await sweepDueItems(new Date(at.getTime() - 1))).toBe(0);
      const jittered = new Date(at.getTime() + 25);
      const counts = await Promise.all([sweepDueItems(jittered), sweepDueItems(jittered)]);
      expect(counts.sort()).toEqual([0, ITEM_DUE_BATCH]);
      expect(await sweepDueItems(new Date(at.getTime() + 59_999))).toBe(0);
      const restarted = async (now: Date) => {
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            "--no-env-file",
            "--eval",
            `
            import { initializePlatform } from "@k2b/cloud/start";
            await initializePlatform({ appId: "spaces", source: "env" });
            const { createAppEventTestHarness } = await import("@k2b/cloud/events/testing");
            const { spacesCapabilities } = await import("./src/capabilities");
            createAppEventTestHarness("spaces", spacesCapabilities);
            const { spyOn } = await import("bun:test");
            const settings = await import("@k2b/cloud/services/settings");
            spyOn(settings, "get").mockResolvedValue("Europe/Berlin");
            const { sweepDueItems } = await import("./src/service/item-due-events");
            const count = await sweepDueItems(new Date(${JSON.stringify(now.toISOString())}));
            console.log("DUE_COUNT:" + count);
            process.exit(0);
          `,
          ],
          cwd: new URL("../../", import.meta.url).pathname,
          env: { ...process.env, CLOUD_APP_KEY: "" },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 15_000,
        });
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(stderr).not.toContain("error:");
        expect(exit).toBe(0);
        return Number(/DUE_COUNT:(\d+)/.exec(stdout)?.[1]);
      };
      expect(await restarted(at)).toBe(0);
      const next = new Date(at.getTime() + 60_000);
      expect(await restarted(next)).toBe(2); // the remaining task and the newly due future task
      const [resumed] = await sql<{ started_at: Date }[]>`SELECT started_at FROM spaces.app_event_sweep`;
      expect(resumed!.started_at).toEqual(watermark);
      const moved = due[0]!;
      await sql`UPDATE spaces.items SET deadline = ${new Date(at.getTime() + 180_000)} WHERE id = ${moved.id}::uuid`;
      expect(await sweepDueItems(new Date(at.getTime() + 120_000))).toBe(0);
      expect(await sweepDueItems(new Date(at.getTime() + 180_000))).toBe(1);
      await sql`UPDATE spaces.items SET deadline = ${at} WHERE id = ${moved.id}::uuid`;
      // An old overdue task can fire after its deadline is moved into the future.
      await sql`UPDATE spaces.items SET deadline = ${new Date(at.getTime() + 240_000)} WHERE id = ${oldTimed.id}::uuid`;
      expect(await sweepDueItems(new Date(at.getTime() + 240_000))).toBe(1);
      expect(await sweepDueItems(new Date("2026-10-27T22:59:59Z"))).toBe(0);
      expect(await sweepDueItems(new Date("2026-10-27T23:00:59Z"))).toBe(1); // midnight Europe/Berlin
      const events = (await pending(space.short_id)).filter((e) => e.type === "spaces.item.due");
      expect(events).toHaveLength(ITEM_DUE_BATCH + 5);
      for (const event of events) assertThin(event);
      expect(events.filter((e) => e.subject.id === moved.short_id)).toHaveLength(2);
      expect(
        events.some((e) =>
          [atWatermark.shortId, oldAllDay.shortId, completed.shortId, done.shortId, calendar.shortId].includes(e.subject.id),
        ),
      ).toBe(false);
    } finally {
      zone.mockRestore();
    }
  }, 90_000);

  test("an empty installation timezone uses UTC for all-day due tasks and does not stop timed tasks", async () => {
    const space = await board();
    const timed = await create(space);
    const allDay = await create(space);
    const at = new Date("2026-10-28T00:00:00Z");
    const zone = spyOn(settings, "get").mockResolvedValue("");
    try {
      await sql`UPDATE spaces.items SET deadline = NULL, deadline_date = NULL WHERE space_id = ANY(${toPgUuidArray(spaceIds.filter((id) => id !== space.id))}::uuid[])`;
      await sql`UPDATE spaces.items SET deadline = ${at} WHERE id = ${timed.id}::uuid`;
      await sql`UPDATE spaces.items SET deadline_date = '2026-10-28'::date WHERE id = ${allDay.id}::uuid`;
      await sql`UPDATE spaces.app_event_sweep SET started_at = NULL, last_swept_at = NULL`;
      expect(await sweepDueItems(new Date(at.getTime() - 1))).toBe(0);
      expect(await sweepDueItems(at)).toBe(2);
      expect((await pending(space.short_id)).filter((e) => e.type === "spaces.item.due")).toHaveLength(2);
    } finally {
      zone.mockRestore();
    }
  });

  test("due publication failure rolls back the whole batch, receipts and tick so it can retry", async () => {
    const space = await board();
    const item = await create(space);
    const second = await create(space);
    const at = new Date("2026-10-27T12:00:00Z");
    const zone = spyOn(settings, "get").mockResolvedValue("UTC");
    await sql`UPDATE spaces.items SET deadline = NULL, deadline_date = NULL WHERE space_id = ANY(${toPgUuidArray(spaceIds.filter((id) => id !== space.id))}::uuid[])`;
    await sql`UPDATE spaces.items SET deadline = ${at} WHERE id IN (${item.id}::uuid, ${second.id}::uuid)`;
    await sql`UPDATE spaces.app_event_sweep SET started_at = NULL, last_swept_at = NULL`;
    const watermark = new Date(at.getTime() - 60_000);
    expect(await sweepDueItems(watermark)).toBe(0);
    const original = producer.publishSpacesEvent;
    let published = 0;
    const failure = spyOn(producer, "publishSpacesEvent").mockImplementation(async (...args) => {
      await original(...args);
      if (++published === 2) throw new Error("rollback");
    });
    try {
      await expect(sweepDueItems(at)).rejects.toThrow("rollback");
    } finally {
      failure.mockRestore();
    }
    try {
      const [sweep] = await sql<{ started_at: Date; last_swept_at: Date }[]>`SELECT started_at, last_swept_at FROM spaces.app_event_sweep`;
      expect(sweep).toEqual({ started_at: watermark, last_swept_at: watermark });
      expect(await sql`SELECT * FROM spaces.item_due_events WHERE item_id IN (${item.id}::uuid, ${second.id}::uuid)`).toHaveLength(0);
      expect((await pending(space.short_id)).filter((e) => e.type === "spaces.item.due")).toHaveLength(0);
      expect(await sweepDueItems(at)).toBe(2);
      expect(await sweepDueItems(new Date(at.getTime() + 60_000))).toBe(0);
    } finally {
      zone.mockRestore();
    }
  });
});
