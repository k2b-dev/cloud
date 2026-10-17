import { afterEach, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { TIMEZONE_COOKIE } from "@k2b/cloud/server";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { dates } from "@k2b/stdlib";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { ItemFilterSchema, SpaceItemSchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { get, listCalendar, listFiltered, searchAcross } from "../service/items";
import spacesApi from ".";

const suite = databaseSuite();
setDefaultTimeout(60_000);
afterEach(() => setSystemTime());

suite("Spaces all-day deadline contract", () => {
  test("migration runs twice without changing an existing timed deadline", async () => {
    setSystemTime(new Date("2026-10-24T12:00:00Z"));
    const [space] = await sql<
      { id: string }[]
    >`INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Deadline migration') RETURNING id`;
    try {
      const [column] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name, rank)
        VALUES (${newShortId()}, ${space!.id}, 'Open', 1024) RETURNING id`;
      const [item] = await sql<{ id: string; deadline: Date }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title, deadline)
        VALUES (${newShortId()}, ${space!.id}, ${column!.id}, 'Existing timed', '2026-10-24T15:00:00Z') RETURNING id, deadline`;
      await migrate();
      await migrate();
      const columns = await sql<{ data_type: string }[]>`SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'spaces' AND table_name = 'items' AND column_name = 'deadline_date'`;
      expect(columns).toEqual([{ data_type: "date" }]);
      const constraints = await sql<{ conname: string }[]>`SELECT conname FROM pg_constraint
        WHERE conrelid = 'spaces.items'::regclass AND conname = 'items_deadline_one_kind'`;
      expect(constraints).toEqual([{ conname: "items_deadline_one_kind" }]);
      expect(await get({ id: item!.id })).toMatchObject({ deadline: item!.deadline.toISOString(), deadlineAllDay: false });
      await expect(
        (async () => {
          await sql`UPDATE spaces.items SET deadline_date = '2026-10-24'::date WHERE id = ${item!.id}`;
        })(),
      ).rejects.toThrow();
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}`;
    }
  });

  for (const timeZone of ["America/Los_Angeles", "Pacific/Kiritimati"]) {
    test(`API writes, filters, grouping, calendar and cross-space reads agree in ${timeZone}`, async () => {
      const context = { timeZone };
      const instant = (wall: string) => dates.zonedDateTimeToInstant(wall, timeZone, { disambiguation: "compatible" });
      setSystemTime(new Date(instant("2026-10-24T23:59")));
      const [space] = await sql<{ id: string; short_id: string }[]>`INSERT INTO spaces.spaces (short_id, name)
        VALUES (${newShortId()}, 'Deadline boundary') RETURNING id, short_id`;
      let accountId: string | undefined;
      try {
        const [column] = await sql<{ id: string; short_id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name, rank)
          VALUES (${newShortId()}, ${space!.id}, 'Open', 1024) RETURNING id, short_id`;
        const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
          VALUES (${`Deadlines ${newShortId()}`}, 'agent') RETURNING id`;
        accountId = account!.id;
        const subject = { type: "service_account" as const, serviceAccountId: accountId };
        const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (service_account_id, permission)
          VALUES (${accountId}, 'write') RETURNING id`;
        await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space!.id}, ${access!.id})`;
        const token = await serviceAccountCredentials.createApiToken({
          serviceAccountId: accountId,
          name: "deadline",
          scopes: ["read", "write"],
        });
        if (!token.ok) throw new Error(token.error.message);
        const call = (method: string, path: string, body: unknown) =>
          spacesApi.request(`/${space!.short_id}/items${path}`, {
            method,
            headers: {
              authorization: `Bearer ${token.data.token}`,
              "content-type": "application/json",
              cookie: `${TIMEZONE_COOKIE}=${encodeURIComponent(timeZone)}`,
            },
            body: JSON.stringify(body),
          });
        const add = async (title: string, deadline?: string) => {
          const response = await call("POST", "", { columnId: column!.short_id, title, deadline });
          expect(response.status).toBe(200);
          return SpaceItemSchema.parse(await response.json());
        };
        const today = await add("All-day today", "2026-10-24");
        expect(today).toMatchObject({ deadline: "2026-10-24", deadlineAllDay: true });
        const timedValue = instant("2026-10-24T17:00");
        const timed = await add("Timed today", timedValue);
        expect(timed).toMatchObject({ deadline: timedValue, deadlineAllDay: false });
        await add("Yesterday", "2026-10-23");
        await add("Tomorrow", "2026-10-25");
        await add("End of week", "2026-10-31");
        await add("Undated");
        expect((await call("POST", "", { columnId: column!.short_id, title: "Invalid", deadline: "2026-02-30" })).status).toBe(400);

        const readColumns = () => sql<
          { deadline: Date | null; deadline_date: string | null }[]
        >`SELECT deadline, deadline_date::text AS deadline_date
          FROM spaces.items WHERE short_id = ${today.id}`;
        expect((await readColumns())[0]).toEqual({ deadline: null, deadline_date: "2026-10-24" });
        for (const deadline of [timedValue, "2026-10-24", null]) {
          const response = await call("PATCH", `/${today.id}`, { deadline });
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ deadline, deadlineAllDay: deadline === "2026-10-24" });
          expect((await readColumns())[0]).toEqual({
            deadline: deadline === timedValue ? new Date(timedValue) : null,
            deadline_date: deadline === "2026-10-24" ? deadline : null,
          });
        }
        expect((await call("PATCH", `/${today.id}`, { deadline: "2026-10-24", priority: "high" })).status).toBe(200);
        // A later unrelated edit preserves the date-only kind.
        expect((await call("PATCH", `/${today.id}`, { title: "All-day today" })).status).toBe(200);
        const list = (filter: Record<string, unknown>) =>
          listFiltered({ spaceId: space!.id, filter: ItemFilterSchema.parse({ groupBy: "none", ...filter }), dateConfig: context });
        const titles = async (filter: Record<string, unknown>) => (await list(filter)).items.map((item) => item.title);
        expect(await titles({ deadlineFilter: "overdue" })).toEqual(["Yesterday"]);
        expect(await titles({ deadlineFilter: "today", sort: "deadline" })).toEqual(["All-day today", "Timed today"]);
        expect(await titles({ deadlineFilter: "week" })).toEqual(["All-day today", "Timed today", "Tomorrow"]);
        expect(await titles({ deadlineFilter: "none" })).toEqual(["Undated"]);
        expect(await titles({ overdue: false })).toContain("Undated");
        expect(await titles({ deadlineBefore: instant("2026-10-24T00:00") })).toEqual(["Yesterday"]);
        expect((await list({ groupBy: "deadline" })).groupCounts).toMatchObject({ overdue: 1, "date:2026-10-24": 2, none: 1 });
        const across = await searchAcross({
          subject,
          query: "",
          kinds: "task",
          spaceId: space!.id,
          deadlineFilter: "today",
          dateConfig: context,
          limit: 20,
        });
        expect(across.map(({ item }) => item.title).sort()).toEqual(["All-day today", "Timed today"]);
        const calendar = await listCalendar({
          subject,
          spaceId: space!.id,
          type: "task",
          from: instant("2026-10-24T00:00"),
          to: instant("2026-10-25T00:00"),
          dateConfig: context,
        });
        expect(calendar.map((item) => item.title)).toEqual(["All-day today", "Timed today"]);
        expect(calendar[0]).toMatchObject({ deadline: "2026-10-24", deadlineAllDay: true });
        setSystemTime(new Date(instant("2026-10-25T00:00")));
        expect(await titles({ deadlineFilter: "overdue" })).toEqual(["Yesterday", "All-day today", "Timed today"]);
        expect(await titles({ deadlineFilter: "today" })).toEqual(["Tomorrow"]);
        expect((await list({ groupBy: "deadline" })).groupCounts).toMatchObject({ overdue: 3, "date:2026-10-25": 1 });
      } finally {
        await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}`;
        if (accountId) {
          await sql`DELETE FROM auth.access WHERE service_account_id = ${accountId}`;
          await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}`;
        }
      }
    });
  }
});
