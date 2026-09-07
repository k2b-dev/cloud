import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { listCalendarSourcePage } from "./items";

const canUseDatabase = async () => {
  try {
    const [row] = await sql<
      { items: string | null; access: string | null }[]
    >`SELECT to_regclass('spaces.items')::text AS items, to_regclass('auth.access')::text AS access`;
    return Boolean(row?.items && row.access);
  } catch {
    return false;
  }
};
const suite = (await canUseDatabase()) ? describe : describe.skip;

suite("Calendar source pagination", () => {
  test("passes 101 finished series and keeps a later series with its differently ordered override", async () => {
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users (uid, provider, profile, display_name) VALUES (${crypto.randomUUID()}, 'local', 'user', 'Agenda fixture') RETURNING id`;
    let spaceId: string | undefined;
    let accessId: string | undefined;
    try {
      const [space] = await sql<
        { id: string }[]
      >`INSERT INTO spaces.spaces (short_id, name, color) VALUES (${newShortId()}, 'Agenda source fixture', '#6366f1') RETURNING id`;
      spaceId = space!.id;
      const [access] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access (user_id, permission) VALUES (${user!.id}::uuid, 'read') RETURNING id`;
      accessId = access!.id;
      await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${accessId}::uuid)`;
      const [column] = await sql<
        { id: string }[]
      >`INSERT INTO spaces.columns (short_id, space_id, name, rank) VALUES (${newShortId()}, ${spaceId}::uuid, 'Calendar', 1024) RETURNING id`;
      for (let index = 0; index < 101; index++) {
        const id = `1${crypto.randomUUID().slice(1)}`;
        await sql`INSERT INTO spaces.items (id, short_id, space_id, column_id, title, rank, starts_at, ends_at, recurrence_rrule, recurrence_dtstart)
          VALUES (${id}::uuid, ${newShortId()}, ${spaceId}::uuid, ${column!.id}::uuid, 'Finished', 1024, '2020-01-01T09:00:00Z', '2020-01-01T10:00:00Z', 'FREQ=DAILY;COUNT=1', '2020-01-01T09:00:00Z')`;
      }
      const seriesId = `f${crypto.randomUUID().slice(1)}`;
      const overrideId = `0${crypto.randomUUID().slice(1)}`;
      await sql`INSERT INTO spaces.items (id, short_id, space_id, column_id, title, rank, starts_at, ends_at, recurrence_rrule, recurrence_dtstart)
        VALUES (${seriesId}::uuid, ${newShortId()}, ${spaceId}::uuid, ${column!.id}::uuid, 'Current series', 1024, '2026-01-01T09:00:00Z', '2026-01-01T10:00:00Z', 'FREQ=DAILY;COUNT=1', '2026-01-01T09:00:00Z')`;
      await sql`INSERT INTO spaces.items (id, short_id, space_id, column_id, title, rank, starts_at, ends_at, recurring_event_id, recurrence_id)
        VALUES (${overrideId}::uuid, ${newShortId()}, ${spaceId}::uuid, ${column!.id}::uuid, 'Moved occurrence', 1024, '2026-01-01T11:00:00Z', '2026-01-01T12:00:00Z', ${seriesId}::uuid, '2026-01-01T09:00:00Z')`;
      const params = {
        subject: { type: "user" as const, userId: user!.id },
        spaceId,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
      };
      const first = await listCalendarSourcePage(params);
      expect(first.items).toEqual([]);
      expect(first.nextRootId).toBeDefined();
      const second = await listCalendarSourcePage({ ...params, afterRootId: first.nextRootId });
      expect(second.nextRootId).toBeUndefined();
      expect(second.items.map((item) => item.id)).toEqual([overrideId]);
      expect(second.items[0]?.title).toBe("Moved occurrence");
      expect(second.items[0]?.startsAt).toBe("2026-01-01T11:00:00.000Z");
      await sql`UPDATE spaces.items SET starts_at = '2026-01-02T11:00:00Z', ends_at = '2026-01-02T12:00:00Z' WHERE id = ${overrideId}::uuid`;
      const originalDay = await listCalendarSourcePage({ ...params, afterRootId: first.nextRootId });
      expect(originalDay.items).toEqual([]);
      const movedDay = await listCalendarSourcePage({
        ...params,
        afterRootId: first.nextRootId,
        from: "2026-01-02T00:00:00Z",
        to: "2026-01-03T00:00:00Z",
      });
      expect(movedDay.items.map((item) => item.id)).toEqual([overrideId]);
      expect(movedDay.items[0]?.startsAt).toBe("2026-01-02T11:00:00.000Z");
      await sql`UPDATE spaces.items SET completed_at = now() WHERE id = ${overrideId}::uuid`;
      const completedOriginal = await listCalendarSourcePage({ ...params, afterRootId: first.nextRootId });
      expect(completedOriginal.items).toEqual([]);
      const completedMoved = await listCalendarSourcePage({
        ...params,
        afterRootId: first.nextRootId,
        from: "2026-01-02T00:00:00Z",
        to: "2026-01-03T00:00:00Z",
      });
      expect(completedMoved.items).toEqual([]);
      // The original multi-day occurrence starts before from but still overlaps it.
      await sql`UPDATE spaces.items SET starts_at = '2025-12-31T09:00:00Z', ends_at = '2026-01-02T10:00:00Z', recurrence_dtstart = '2025-12-31T09:00:00Z' WHERE id = ${seriesId}::uuid`;
      await sql`UPDATE spaces.items SET completed_at = NULL, recurrence_id = '2025-12-31T09:00:00Z', starts_at = '2026-01-03T11:00:00Z', ends_at = '2026-01-03T12:00:00Z' WHERE id = ${overrideId}::uuid`;
      const overlappingOriginal = await listCalendarSourcePage({ ...params, afterRootId: first.nextRootId });
      expect(overlappingOriginal.items).toEqual([]);
      const multiDayMoved = await listCalendarSourcePage({
        ...params,
        afterRootId: first.nextRootId,
        from: "2026-01-03T00:00:00Z",
        to: "2026-01-04T00:00:00Z",
      });
      expect(multiDayMoved.items.map((item) => item.id)).toEqual([overrideId]);
      await sql`UPDATE spaces.items SET completed_at = now() WHERE id = ${overrideId}::uuid`;
      const completedOverlappingOriginal = await listCalendarSourcePage({ ...params, afterRootId: first.nextRootId });
      expect(completedOverlappingOriginal.items).toEqual([]);
      const denied = await listCalendarSourcePage({ ...params, subject: { type: "user", userId: crypto.randomUUID() } });
      expect(denied.items).toEqual([]);
      expect(denied.nextRootId).toBeUndefined();
    } finally {
      if (spaceId) await sql`DELETE FROM spaces.spaces WHERE id = ${spaceId}::uuid`;
      if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  }, 20_000);
});
