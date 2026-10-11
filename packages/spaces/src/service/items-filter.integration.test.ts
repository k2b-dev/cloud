import { expect, test } from "bun:test";
import { dates } from "@k2b/stdlib";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { type ItemFilter, ItemFilterSchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import { listFiltered } from "./items";
import { projectItemListResult } from "./public-resources";

const suite = databaseSuite();

test("itemIds accepts only public short IDs and at most 100 entries", () => {
  expect(ItemFilterSchema.safeParse({ itemIds: [newShortId()] }).success).toBe(true);
  expect(ItemFilterSchema.safeParse({ itemIds: [crypto.randomUUID()] }).success).toBe(false);
  expect(ItemFilterSchema.safeParse({ itemIds: Array.from({ length: 101 }, () => newShortId()) }).success).toBe(false);
});

suite("Spaces item ID filter", () => {
  test("restricts items and totals by public IDs and intersects the existing column and status filters", async () => {
    const spaces = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name)
      VALUES (${newShortId()}, 'Item filter test'), (${newShortId()}, 'Other filter test') RETURNING id
    `;
    const spaceId = spaces[0]!.id;
    const otherSpaceId = spaces[1]!.id;
    try {
      const columns = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${spaceId}::uuid, 'Open', 1024, false),
               (${newShortId()}, ${spaceId}::uuid, 'Done', 2048, true),
               (${newShortId()}, ${otherSpaceId}::uuid, 'Other', 1024, false) RETURNING id
      `;
      const items = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, completed_at)
        VALUES (${newShortId()}, ${spaceId}::uuid, ${columns[0]!.id}::uuid, 'First', NULL),
               (${newShortId()}, ${spaceId}::uuid, ${columns[0]!.id}::uuid, 'Second', NULL),
               (${newShortId()}, ${spaceId}::uuid, ${columns[1]!.id}::uuid, 'Finished', now()),
               (${newShortId()}, ${otherSpaceId}::uuid, ${columns[2]!.id}::uuid, 'Other', NULL)
        RETURNING id, short_id
      `;
      const first = items[0]!;
      const finished = items[2]!;
      const list = (filter: Partial<ItemFilter>) => listFiltered({ spaceId, filter: ItemFilterSchema.parse(filter) });

      expect(await list({ itemIds: [first.short_id], pageSize: 1 })).toMatchObject({
        items: [{ id: first.id }],
        total: 1,
        totalPages: 1,
      });
      const both = await list({ itemIds: [first.short_id, finished.short_id], status: "all", pageSize: 1 });
      expect(both).toMatchObject({ total: 2, totalPages: 2 });
      expect(both.items).toHaveLength(1);
      // Column IDs are already resolved by the transport; itemIds remain public at the service seam.
      const columnMismatch = await listFiltered({
        spaceId,
        filter: { ...ItemFilterSchema.parse({ itemIds: [first.short_id] }), columnIds: [columns[1]!.id] },
      });
      expect(columnMismatch).toMatchObject({ items: [], total: 0 });
      expect(await list({ itemIds: [finished.short_id], status: "active" })).toMatchObject({ items: [], total: 0 });
      expect(await list({ itemIds: [finished.short_id], status: "completed" })).toMatchObject({ items: [{ id: finished.id }], total: 1 });
      expect(await list({ itemIds: [items[3]!.short_id, newShortId()] })).toMatchObject({ items: [], total: 0 });
      expect(await list({ itemIds: [] })).toMatchObject({ items: [], total: 0 });
      expect(await list({})).toMatchObject({ total: 2 });

      await sql`DELETE FROM spaces.items WHERE id = ${first.id}::uuid`;
      expect(await list({ itemIds: [first.short_id] })).toMatchObject({ items: [], total: 0 });
    } finally {
      for (const space of spaces) await sql`DELETE FROM spaces.spaces WHERE id = ${space.id}::uuid`;
    }
  });
});

suite("Spaces grouped pagination", () => {
  test("orders priority groups before the selected sort and counts every filtered item across pages", async () => {
    const [space] = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Grouped pagination') RETURNING id
    `;
    const spaceId = space!.id;
    try {
      const [column] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank)
        VALUES (${newShortId()}, ${spaceId}::uuid, 'Open', 1024) RETURNING id
      `;
      // A title sort alone puts the other priorities before the urgent group.
      for (let n = 0; n < 55; n++) {
        await sql`INSERT INTO spaces.items (short_id, space_id, column_id, title, priority)
          VALUES (${newShortId()}, ${spaceId}::uuid, ${column!.id}::uuid, ${`Match urgent ${String(n).padStart(2, "0")}`}, 'urgent')`;
      }
      for (const priority of ["high", "medium", "low", null, "urgent"]) {
        await sql`INSERT INTO spaces.items (short_id, space_id, column_id, title, priority)
          VALUES (${newShortId()}, ${spaceId}::uuid, ${column!.id}::uuid,
            ${priority === "urgent" ? "Excluded urgent" : `Match aaa ${priority ?? "none"}`}, ${priority})`;
      }
      const list = (filter: Partial<ItemFilter>) =>
        listFiltered({
          spaceId,
          filter: ItemFilterSchema.parse({ groupBy: "priority", sort: "title", search: "Match", ...filter }),
        });
      const first = await list({});
      expect(first.items).toHaveLength(50);
      expect(first.items.every((item) => item.priority === "urgent")).toBe(true);
      expect(first.items.map((item) => item.title)).toEqual(
        Array.from({ length: 50 }, (_, n) => `Match urgent ${String(n).padStart(2, "0")}`),
      );
      expect(first).toMatchObject({ total: 59, totalPages: 2, groupCounts: { urgent: 55, high: 1, medium: 1, low: 1, none: 1 } });
      const second = await list({ page: 2 });
      expect(second.items.map((item) => item.priority)).toEqual([
        "urgent",
        "urgent",
        "urgent",
        "urgent",
        "urgent",
        "high",
        "medium",
        "low",
        null,
      ]);
      expect(second.groupCounts).toEqual(first.groupCounts);
      expect(await list({ sort: "priority", sortDesc: true, pageSize: 1 })).toMatchObject({ items: [{ priority: "urgent" }] });
      const ungrouped = await list({ groupBy: "none", pageSize: 1 });
      expect(ungrouped.items[0]!.title).toBe("Match aaa high");
      expect(ungrouped).not.toHaveProperty("groupCounts");
      expect(await list({ search: "missing" })).toMatchObject({ items: [], total: 0, groupCounts: {} });
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${spaceId}::uuid`;
    }
  });

  test("orders schedule days in the viewer timezone and projects full column and multi-tag counts", async () => {
    const dateConfig = { timeZone: "America/Los_Angeles", locale: "en" };
    const yesterday = dates.addDays(dates.today(dateConfig), -1, dateConfig).toISOString();
    const yesterdayKey = dates.formatDateKey(yesterday, dateConfig);
    const [space] = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Schedule pagination') RETURNING id
    `;
    const spaceId = space!.id;
    try {
      const columns = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank)
        VALUES (${newShortId()}, ${spaceId}::uuid, 'Later', 2048), (${newShortId()}, ${spaceId}::uuid, 'First', 1024)
        RETURNING id, short_id
      `;
      const specs = [
        { title: "Overdue", deadline: yesterday, priority: "low" },
        {
          title: "Past event",
          startsAt: yesterday,
          endsAt: new Date(Date.parse(yesterday) + 3600_000).toISOString(),
          deadline: "2099-01-05T10:00:00Z",
          priority: "low",
        },
        { title: "Completed past task", deadline: yesterday, completedAt: yesterday, priority: "low" },
        { title: "Soon low", deadline: "2099-01-01T23:00:00Z", priority: "low" },
        {
          title: "Later urgent",
          startsAt: "2099-01-03T00:30:00Z",
          endsAt: "2099-01-03T01:30:00Z",
          deadline: yesterday,
          priority: "urgent",
        },
        { title: "Soon high", deadline: "2099-01-02T00:30:00Z", priority: "high" },
        { title: "Unscheduled", priority: "urgent" },
      ];
      const inserted: { id: string; short_id: string }[] = [];
      for (const spec of specs) {
        const [item] = await sql<{ id: string; short_id: string }[]>`
          INSERT INTO spaces.items (short_id, space_id, column_id, title, deadline, starts_at, ends_at, completed_at, priority)
          VALUES (${newShortId()}, ${spaceId}::uuid, ${columns[spec.title === "Later urgent" ? 0 : 1]!.id}::uuid,
            ${spec.title}, ${"deadline" in spec ? spec.deadline : null}::timestamptz,
            ${"startsAt" in spec ? spec.startsAt : null}::timestamptz, ${"endsAt" in spec ? spec.endsAt : null}::timestamptz,
            ${"completedAt" in spec ? spec.completedAt : null}::timestamptz, ${spec.priority})
          RETURNING id, short_id
        `;
        inserted.push(item!);
      }
      const list = (filter: Partial<ItemFilter>) =>
        listFiltered({
          spaceId,
          dateConfig,
          filter: ItemFilterSchema.parse({ status: "all", sort: "priority", groupBy: "deadline", ...filter }),
        });
      const schedule = await list({});
      expect(schedule.items.map((item) => item.title)).toEqual([
        "Overdue",
        "Past event",
        "Completed past task",
        "Soon high",
        "Soon low",
        "Later urgent",
        "Unscheduled",
      ]);
      expect(schedule.groupCounts).toEqual({
        overdue: 1,
        "past-events": 1,
        [`date:${yesterdayKey}`]: 1,
        "date:2099-01-01": 2,
        "date:2099-01-02": 1,
        none: 1,
      });
      const dayPage = await list({ pageSize: 1, page: 4 });
      expect(dayPage.items[0]!.title).toBe("Soon high");
      expect(dayPage.groupCounts).toEqual(schedule.groupCounts);
      expect((await list({ sortDesc: true })).items.slice(3, 5).map((item) => item.title)).toEqual(["Soon low", "Soon high"]);

      const columnResult = await list({ groupBy: "column", sort: "title", sortDesc: true, pageSize: 1 });
      expect(columnResult.items[0]!.columnId).toBe(columns[1]!.id);
      expect((await projectItemListResult(columnResult, "column")).groupCounts).toEqual({
        [columns[0]!.short_id]: 1,
        [columns[1]!.short_id]: 6,
      });
      const tags = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO spaces.tags (short_id, space_id, name, color)
        VALUES (${newShortId()}, ${spaceId}::uuid, 'Beta', '#ff0000'), (${newShortId()}, ${spaceId}::uuid, 'Alpha', '#00ff00')
        RETURNING id, short_id
      `;
      await sql`INSERT INTO spaces.item_tags (item_id, tag_id) VALUES
        (${inserted[3]!.id}::uuid, ${tags[0]!.id}::uuid), (${inserted[3]!.id}::uuid, ${tags[1]!.id}::uuid),
        (${inserted[4]!.id}::uuid, ${tags[0]!.id}::uuid)`;
      const tagFilter = {
        groupBy: "tag",
        sort: "title",
        itemIds: [inserted[0]!.short_id, inserted[3]!.short_id, inserted[4]!.short_id],
      } satisfies Partial<ItemFilter>;
      // Pages follow the first tag (Alpha, Beta, no tag), but a page keeps the title sort: Beta lists
      // "Later urgent" before the multi-tag "Soon low".
      const tagTitles = async (filter: Partial<ItemFilter>) => (await list({ ...tagFilter, ...filter })).items.map((item) => item.title);
      expect(await tagTitles({})).toEqual(["Later urgent", "Overdue", "Soon low"]);
      expect([...(await tagTitles({ pageSize: 1 })), ...(await tagTitles({ pageSize: 1, page: 2 }))]).toEqual(["Soon low", "Later urgent"]);
      const tagPage = await list({ ...tagFilter, pageSize: 1 });
      const publicTags = await projectItemListResult(tagPage, "tag");
      expect(publicTags.groupCounts).toEqual({ [tags[0]!.short_id]: 2, [tags[1]!.short_id]: 1, none: 1 });
      expect(publicTags.items[0]!.tags!.map((tag) => tag.id).sort()).toEqual(tags.map((tag) => tag.short_id).sort());
      // Beta still has its full count on a page containing only an untagged item.
      expect((await projectItemListResult(await list({ ...tagFilter, pageSize: 1, page: 3 }), "tag")).groupCounts).toEqual(
        publicTags.groupCounts,
      );
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${spaceId}::uuid`;
    }
  });
});
