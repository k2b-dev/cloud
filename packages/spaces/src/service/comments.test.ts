import { describe, expect, test } from "bun:test";
import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { create as createComment, list, remove as removeComment, update as updateComment } from "./comments";
import { latestSpaceEventCursor, liveSpaceEvents } from "./events";
import { create, splitRecurring, update } from "./items";

const canUseDatabase = async () => {
  try {
    const [row] = await sql<{ comments: string | null }[]>`SELECT to_regclass('spaces.comments')::text AS comments`;
    return Boolean(row?.comments);
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = (await canUseDatabase()) ? describe : describe.skip;

suite("Spaces comment pagination", () => {
  test("allows only the author to edit and delete during the first 10 minutes", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [user, otherUser] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES
        (${`spaces-comment-author-${suffix}`}, 'local', 'user', 'Comment Author', false),
        (${`spaces-comment-other-${suffix}`}, 'local', 'user', 'Other User', false)
      RETURNING id
    `;
    const [space] = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name, description, color)
      VALUES (${newShortId()}, ${`Comment policy ${suffix}`}, 'comment policy test', '#2563eb')
      RETURNING id
    `;
    try {
      const [column] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${space!.id}::uuid, 'To Do', 1024, false)
        RETURNING id
      `;
      const [item] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, rank)
        VALUES (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Review policy', 1024)
        RETURNING id
      `;
      const eventAbort = new AbortController();
      const cursor = (await latestSpaceEventCursor(space!.id)) ?? "0-0";
      const nextEvent = liveSpaceEvents({ spaceId: space!.id, after: cursor, signal: eventAbort.signal })[Symbol.asyncIterator]().next();
      const created = await createComment({ itemId: item!.id, userId: user!.id, content: "Initial context" });
      expect(created).toMatchObject({ ok: true, data: { canEdit: true, canDelete: true } });
      if (!created.ok) return;
      const live = await Promise.race([
        nextEvent,
        Bun.sleep(2_000).then(() => {
          throw new Error("Timed out waiting for comment live event");
        }),
      ]);
      eventAbort.abort();
      expect(live.value?.data.public).toMatchObject({ type: "item.updated", itemId: expect.any(String) });

      const otherView = await list({ itemId: item!.id, viewerUserId: otherUser!.id });
      expect(otherView.items[0]).toMatchObject({ canEdit: false, canDelete: false });
      expect(await updateComment({ id: created.data.id, content: "Overwrite", userId: otherUser!.id })).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(await updateComment({ id: created.data.id, content: "Corrected context", userId: user!.id })).toMatchObject({ ok: true });

      await sql`
        UPDATE spaces.comments
        SET created_at = now() - interval '11 minutes'
        WHERE id = ${created.data.id}::uuid
      `;
      const expiredView = await list({ itemId: item!.id, viewerUserId: user!.id });
      expect(expiredView.items[0]).toMatchObject({ canEdit: false, canDelete: false });
      expect(await updateComment({ id: created.data.id, content: "Too late", userId: user!.id })).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(await removeComment({ id: created.data.id, userId: user!.id })).toMatchObject({ ok: false, status: 403 });

      const removable = await createComment({ itemId: item!.id, userId: user!.id, content: "Remove promptly" });
      expect(removable.ok).toBe(true);
      if (removable.ok) expect(await removeComment({ id: removable.data.id, userId: user!.id })).toEqual({ ok: true, data: undefined });
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id IN (${user!.id}::uuid, ${otherUser!.id}::uuid)`;
    }
  });

  test("returns the newest bounded page in chronological display order", async () => {
    const [space] = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name, description, color)
      VALUES (${newShortId()}, ${`Comments Test ${crypto.randomUUID()}`}, 'comments pagination test', '#2563eb')
      RETURNING id
    `;

    try {
      const [column] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${space!.id}::uuid, 'To Do', 1024, false)
        RETURNING id
      `;
      const [item] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (
          short_id, space_id, column_id, title, starts_at, ends_at, recurrence_rrule, recurrence_dtstart, rank
        )
        VALUES (
          ${newShortId()},
          ${space!.id}::uuid,
          ${column!.id}::uuid,
          'Review comments',
          '2026-07-01T09:00:00.000Z',
          '2026-07-01T09:30:00.000Z',
          'FREQ=DAILY',
          '2026-07-01T09:00:00.000Z',
          1024
        )
        RETURNING id
      `;
      const commentShortIds = toPgTextArray(Array.from({ length: 55 }, newShortId));
      await sql`
        INSERT INTO spaces.comments (short_id, item_id, user_id, content, created_at, updated_at)
        SELECT
          generated.short_id,
          ${item!.id}::uuid,
          NULL,
          'Comment ' || generated.entry,
          '2026-01-01T00:00:00Z'::timestamptz + generated.entry * interval '1 minute',
          '2026-01-01T00:00:00Z'::timestamptz + generated.entry * interval '1 minute'
        FROM unnest(${commentShortIds}::text[]) WITH ORDINALITY AS generated(short_id, entry)
      `;

      const first = await list({ itemId: item!.id, pagination: { page: 1, perPage: 20 } });
      expect(first.total).toBe(55);
      expect(first.hasNext).toBe(true);
      expect(first.items.map((entry) => entry.content)).toEqual(Array.from({ length: 20 }, (_, index) => `Comment ${index + 36}`));

      const last = await list({ itemId: item!.id, pagination: { page: 3, perPage: 20 } });
      expect(last.hasNext).toBe(false);
      expect(last.items.map((entry) => entry.content)).toEqual(Array.from({ length: 15 }, (_, index) => `Comment ${index + 1}`));

      const invalidOverride = await create({
        spaceId: space!.id,
        data: {
          columnId: column!.id,
          title: "Invalid override",
          startsAt: "2026-07-19T10:00:00.000Z",
          endsAt: "2026-07-19T10:30:00.000Z",
          recurringEventId: item!.id,
          recurrenceId: "2026-07-19T10:00:00.000Z",
        },
        createdBy: null,
      });
      expect(invalidOverride).toMatchObject({ ok: false, status: 400 });

      const validOverrideInput = {
        spaceId: space!.id,
        data: {
          columnId: column!.id,
          title: "Valid override",
          startsAt: "2026-07-19T10:00:00.000Z",
          endsAt: "2026-07-19T10:30:00.000Z",
          recurringEventId: item!.id,
          recurrenceId: "2026-07-19T09:00:00.000Z",
        },
        createdBy: null,
      };
      expect((await create(validOverrideInput)).ok).toBe(true);
      expect(await create(validOverrideInput)).toMatchObject({ ok: false, status: 409 });

      const firstOccurrence = "2026-07-17T09:00:00.000Z";
      const secondOccurrence = "2026-07-18T09:00:00.000Z";
      await sql`
        INSERT INTO spaces.comments (short_id, item_id, recurrence_id, user_id, content)
        VALUES
          (${newShortId()}, ${item!.id}::uuid, ${firstOccurrence}::timestamptz, NULL, 'First occurrence'),
          (${newShortId()}, ${item!.id}::uuid, ${secondOccurrence}::timestamptz, NULL, 'Second occurrence')
      `;

      const series = await list({ itemId: item!.id });
      expect(series.total).toBe(55);
      const occurrence = await list({ itemId: item!.id, recurrenceId: firstOccurrence });
      expect(occurrence.items.map((entry) => [entry.content, entry.recurrenceId])).toEqual([["First occurrence", firstOccurrence]]);

      const [override] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (
          short_id, space_id, column_id, title, starts_at, ends_at, recurring_event_id, recurrence_id, rank
        )
        VALUES (
          ${newShortId()},
          ${space!.id}::uuid,
          ${column!.id}::uuid,
          'Moved occurrence',
          '2026-07-17T10:00:00.000Z',
          '2026-07-17T10:30:00.000Z',
          ${item!.id}::uuid,
          ${firstOccurrence}::timestamptz,
          2048
        )
        RETURNING id
      `;
      const shifted = await update({
        id: item!.id,
        data: {
          startsAt: "2026-07-01T10:00:00.000Z",
          endsAt: "2026-07-01T10:30:00.000Z",
        },
      });
      expect(shifted.ok).toBe(true);
      const [shiftedOverride] = await sql<{ recurrence_id: Date; starts_at: Date }[]>`
        SELECT recurrence_id, starts_at
        FROM spaces.items
        WHERE id = ${override!.id}::uuid
      `;
      expect(shiftedOverride?.recurrence_id.toISOString()).toBe("2026-07-17T10:00:00.000Z");
      expect(shiftedOverride?.starts_at.toISOString()).toBe("2026-07-17T11:00:00.000Z");
      const shiftedOccurrence = await list({ itemId: item!.id, recurrenceId: "2026-07-17T10:00:00.000Z" });
      expect(shiftedOccurrence.items.map((entry) => entry.content)).toEqual(["First occurrence"]);

      const splitRecurrenceId = "2026-07-18T10:00:00.000Z";
      await sql`
        INSERT INTO spaces.item_resource_refs (item_id, resource_type, resource_id, label)
        VALUES (${item!.id}::uuid, 'mail.conversation', 'Conv01', 'Planning')
      `;
      const [futureOverride] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (
          short_id, space_id, column_id, title, starts_at, ends_at, recurring_event_id, recurrence_id, rank
        )
        VALUES (
          ${newShortId()},
          ${space!.id}::uuid,
          ${column!.id}::uuid,
          'Future moved occurrence',
          '2026-07-18T13:00:00.000Z',
          '2026-07-18T13:30:00.000Z',
          ${item!.id}::uuid,
          ${splitRecurrenceId}::timestamptz,
          3072
        )
        RETURNING id
      `;
      const split = await splitRecurring({
        id: item!.id,
        data: {
          recurrenceId: splitRecurrenceId,
          startsAt: "2026-07-18T12:00:00.000Z",
          endsAt: "2026-07-18T12:30:00.000Z",
          allDay: false,
        },
        createdBy: null,
      });
      expect(split.ok).toBe(true);
      if (!split.ok) throw new Error(split.error);

      const [movedOverride] = await sql<{ recurring_event_id: string; recurrence_id: Date; starts_at: Date }[]>`
        SELECT recurring_event_id, recurrence_id, starts_at
        FROM spaces.items
        WHERE id = ${futureOverride!.id}::uuid
      `;
      expect(movedOverride?.recurring_event_id).toBe(split.data.id);
      expect(movedOverride?.recurrence_id.toISOString()).toBe("2026-07-18T12:00:00.000Z");
      expect(movedOverride?.starts_at.toISOString()).toBe("2026-07-18T15:00:00.000Z");
      const movedComment = await list({ itemId: split.data.id, recurrenceId: "2026-07-18T12:00:00.000Z" });
      expect(movedComment.items.map((entry) => entry.content)).toEqual(["Second occurrence"]);
      expect((await list({ itemId: item!.id, recurrenceId: splitRecurrenceId })).total).toBe(0);
      const [splitReference] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM spaces.item_resource_refs
        WHERE item_id = ${split.data.id}::uuid
          AND resource_type = 'mail.conversation'
          AND resource_id = 'Conv01'
      `;
      expect(splitReference?.count).toBe(1);

      const [seriesBefore] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM spaces.items
        WHERE space_id = ${space!.id}::uuid
          AND recurrence_rrule IS NOT NULL
      `;
      const firstOccurrenceMove = await splitRecurring({
        id: split.data.id,
        data: {
          recurrenceId: "2026-07-18T12:00:00.000Z",
          startsAt: "2026-07-18T14:00:00.000Z",
          endsAt: "2026-07-18T14:30:00.000Z",
          allDay: false,
        },
        createdBy: null,
      });
      expect(firstOccurrenceMove.ok).toBe(true);
      if (!firstOccurrenceMove.ok) throw new Error(firstOccurrenceMove.error);
      expect(firstOccurrenceMove.data.id).toBe(split.data.id);
      const [seriesAfter] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM spaces.items
        WHERE space_id = ${space!.id}::uuid
          AND recurrence_rrule IS NOT NULL
      `;
      expect(seriesAfter?.count).toBe(seriesBefore?.count);
      expect((await list({ itemId: split.data.id, recurrenceId: "2026-07-18T14:00:00.000Z" })).items[0]?.content).toBe("Second occurrence");
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}::uuid`;
    }
  });
});
