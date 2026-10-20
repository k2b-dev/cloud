import { expect, setDefaultTimeout, test } from "bun:test";
import { accounts, serviceAccountCredentials } from "@k2b/cloud/services";
import { createTestBrowserSignIn } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { newShortId } from "../lib/short-id";
import spacesApi from ".";

const suite = databaseSuite();
setDefaultTimeout(60_000);

type TrayList = { items: { id: string; title: string }[]; total: number };
type Snapshot = {
  kind: string;
  view: string;
  range: { from: string; to: string };
  items: { id: string; activeBlockerCount: number }[];
  weather: object;
  tray: { overdue: TrayList; undated: TrayList } | null;
};

suite("Spaces calendar day view", () => {
  test("carries each item's blocker count within the reader's access, loads days in ranges, and opens an old timeline link as the month", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const spaceIds: string[] = [];
    const userIds: string[] = [];
    try {
      const space = async (name: string) => {
        const [row] = await sql<{ id: string; short_id: string }[]>`
          INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, ${`${name} ${suffix}`}) RETURNING id, short_id`;
        spaceIds.push(row!.id);
        const [column] = await sql<{ id: string }[]>`
          INSERT INTO spaces.columns (short_id, space_id, name, rank) VALUES (${newShortId()}, ${row!.id}::uuid, 'Open', 1024) RETURNING id`;
        return { ...row!, columnId: column!.id };
      };
      const team = await space("Team");
      const other = await space("Other");
      const item = async (
        target: { id: string; columnId: string },
        title: string,
        times: { startsAt?: string; endsAt?: string; deadline?: string; completed?: boolean },
      ) => {
        const [row] = await sql<{ id: string; short_id: string }[]>`
          INSERT INTO spaces.items (short_id, space_id, column_id, title, starts_at, ends_at, deadline, completed_at)
          VALUES (${newShortId()}, ${target.id}::uuid, ${target.columnId}::uuid, ${title}, ${times.startsAt ?? null}::timestamptz,
            ${times.endsAt ?? null}::timestamptz, ${times.deadline ?? null}::timestamptz,
            ${times.completed ? new Date().toISOString() : null}::timestamptz)
          RETURNING id, short_id`;
        ids.set(row!.short_id, row!.id);
        return row!.short_id;
      };
      const ids = new Map<string, string>();
      const planning = await item(team, "Planning", { startsAt: "2030-03-13T10:00:00Z", endsAt: "2030-03-13T11:30:00Z" });
      const invoice = await item(team, "Check invoice", { deadline: "2030-03-14T15:00:00Z" });
      await item(team, "Done already", { deadline: "2030-03-14T16:00:00Z", completed: true });
      const retro = await item(team, "Retro", { deadline: "2030-03-25T12:00:00Z" });
      await item(other, "Elsewhere", { startsAt: "2030-03-13T10:00:00Z", endsAt: "2030-03-13T11:00:00Z" });
      // An open task blocks the invoice, so the calendar says it cannot be completed yet.
      const receipts = await item(team, "Collect receipts", {});
      await sql`INSERT INTO spaces.item_dependencies (item_id, blocker_item_id) VALUES (${ids.get(invoice)}::uuid, ${ids.get(receipts)}::uuid)`;

      const reader = async (name: string, spaceId?: string) => {
        const id = crypto.randomUUID();
        await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name) VALUES (${id}::uuid, ${`${name}-${suffix}`}, 'local', 'user', ${name})`;
        userIds.push(id);
        if (spaceId) {
          const [access] = await sql<{ id: string }[]>`
            INSERT INTO auth.access (user_id, permission) VALUES (${id}::uuid, 'read') RETURNING id`;
          await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${access!.id}::uuid)`;
        }
        const loaded = await accounts.users.get({ id });
        if (!loaded) throw new Error("Missing fixture user");
        const token = await serviceAccountCredentials.createUserApiToken({
          user: loaded,
          browserSignIn: await createTestBrowserSignIn(loaded.id),
          name: `${name} key`,
        });
        if (!token.ok) throw new Error(token.error.message);
        return (query: string) =>
          spacesApi.request(`/workspace/view?${query}`, { headers: { authorization: `Bearer ${token.data.token}` } });
      };
      const member = await reader("Member", team.id);
      const outsider = await reader("Outsider");
      const href = (cv: string, cd = "2030-03-14") => encodeURIComponent(`/app/spaces/${team.short_id}?view=calendar&cv=${cv}&cd=${cd}`);
      const items = async (response: Response) => {
        expect(response.status).toBe(200);
        return ((await response.json()) as Snapshot).items.map((entry) => [entry.id, entry.activeBlockerCount]);
      };

      // The day view loads a week before its day and three after, and names the days it loaded.
      const day = await member(`href=${href("day")}`);
      expect(new Set(await items(day.clone()))).toEqual(
        new Set([
          [planning, 0],
          [invoice, 1],
          [retro, 0],
        ]),
      );
      expect(((await day.json()) as Snapshot).range).toEqual({ from: "2030-03-07T00:00:00.000Z", to: "2030-04-05T00:00:00.000Z" });
      expect((await outsider(`href=${href("day")}`)).status).toBe(403);

      // While the reader scrolls, day, week, and month load a chosen block without the tray.
      const block = (cv: string, from: string, to: string) =>
        member(`href=${href(cv)}&from=${from}T00:00:00.000Z&to=${to}T00:00:00.000Z&includeTray=false`);
      const week = await block("week", "2030-03-14", "2030-03-21");
      const loaded = (await week.clone().json()) as Snapshot;
      expect(loaded).toMatchObject({
        view: "week",
        range: { from: "2030-03-14T00:00:00.000Z", to: "2030-03-21T00:00:00.000Z" },
        tray: null,
      });
      expect(await items(week)).toEqual([[invoice, 1]]);
      // The night after the last day belongs to it: a range holds what lies there until 06:00.
      const night = await item(team, "Night shift", { startsAt: "2030-03-21T03:00:00Z", endsAt: "2030-03-21T04:00:00Z" });
      expect(await items(await block("day", "2030-03-14", "2030-03-21"))).toEqual([
        [invoice, 1],
        [night, 0],
      ]);
      expect(await items(await block("day", "2030-03-21", "2030-03-28"))).toEqual([
        [night, 0],
        [retro, 0],
      ]);
      // A range has both ends, runs forward, and spans at most 366 days.
      const monthBlock = await block("month", "2030-03-14", "2030-05-09");
      expect(monthBlock.status).toBe(200);
      expect((await monthBlock.json()) as Snapshot).toMatchObject({
        kind: "calendar",
        view: "month",
        tray: null,
        range: { from: "2030-03-14T00:00:00.000Z", to: "2030-05-09T00:00:00.000Z" },
      });
      // A URL without a view opens the month, and its weeks load the same way.
      const plain = encodeURIComponent(`/app/spaces/${team.short_id}?view=calendar&cd=2030-03-14`);
      const defaultMonth = await member(`href=${plain}&from=2030-05-09T00:00:00.000Z&to=2030-07-04T00:00:00.000Z&includeTray=false`);
      expect(((await defaultMonth.json()) as Snapshot).range).toEqual({ from: "2030-05-09T00:00:00.000Z", to: "2030-07-04T00:00:00.000Z" });

      expect((await member(`href=${href("day")}&from=2030-03-14T00:00:00.000Z`)).status).toBe(400);
      expect((await block("day", "2030-03-21", "2030-03-14")).status).toBe(400);
      expect((await block("day", "2030-01-01", "2031-01-03")).status).toBe(400);

      // The timeline view is gone: an old link, with the range the timeline used to send, opens the month of its day.
      const old = await member(`href=${href("timeline")}&from=2030-03-20T00:00:00.000Z&to=2030-03-27T00:00:00.000Z&includeTray=false`);
      expect(old.status).toBe(200);
      const month = (await old.json()) as Snapshot;
      expect(month).toMatchObject({ kind: "calendar", view: "month", tray: null });
      expect(month.items.map((entry) => entry.id)).toContain(planning);
    } finally {
      for (const id of spaceIds) await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
      for (const id of userIds) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id IN (
          SELECT id FROM auth.service_accounts WHERE delegated_user_id = ${id}::uuid)`;
        await sql`DELETE FROM auth.service_accounts WHERE delegated_user_id = ${id}::uuid`;
        await sql`DELETE FROM auth.access WHERE user_id = ${id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
      }
    }
  });

  test("brings the overdue tasks of the Space and the reader's undated tasks, a few each, under the calendar's filter", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const spaceIds: string[] = [];
    const userIds: string[] = [];
    try {
      const space = async (name: string) => {
        const [row] = await sql<{ id: string; short_id: string }[]>`
          INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, ${`${name} ${suffix}`}) RETURNING id, short_id`;
        spaceIds.push(row!.id);
        const [column] = await sql<{ id: string }[]>`
          INSERT INTO spaces.columns (short_id, space_id, name, rank) VALUES (${newShortId()}, ${row!.id}::uuid, 'Open', 1024) RETURNING id`;
        return { ...row!, columnId: column!.id };
      };
      const team = await space("Team");
      const other = await space("Other");
      const user = async (name: string, spaceId?: string) => {
        const id = crypto.randomUUID();
        await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name) VALUES (${id}::uuid, ${`${name}-${suffix}`}, 'local', 'user', ${name})`;
        userIds.push(id);
        if (spaceId) {
          const [access] = await sql<{ id: string }[]>`
            INSERT INTO auth.access (user_id, permission) VALUES (${id}::uuid, 'read') RETURNING id`;
          await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${access!.id}::uuid)`;
        }
        return id;
      };
      const memberId = await user("Member", team.id);
      const colleagueId = await user("Colleague", team.id);
      const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
      const item = async (
        target: { id: string; columnId: string },
        title: string,
        fields: { deadline?: string; startsAt?: string; endsAt?: string; completed?: boolean; priority?: string; assignee?: string },
      ) => {
        const [row] = await sql<{ id: string; short_id: string }[]>`
          INSERT INTO spaces.items (short_id, space_id, column_id, title, starts_at, ends_at, deadline, priority, completed_at)
          VALUES (${newShortId()}, ${target.id}::uuid, ${target.columnId}::uuid, ${title}, ${fields.startsAt ?? null}::timestamptz,
            ${fields.endsAt ?? null}::timestamptz, ${fields.deadline ?? null}::timestamptz, ${fields.priority ?? null},
            ${fields.completed ? new Date().toISOString() : null}::timestamptz)
          RETURNING id, short_id`;
        if (fields.assignee)
          await sql`INSERT INTO spaces.item_assignees (item_id, user_id) VALUES (${row!.id}::uuid, ${fields.assignee}::uuid)`;
        return row!.short_id;
      };
      // Six overdue tasks, so the tray shows the five most recent and counts all six.
      const overdue: string[] = [];
      for (let days = 2; days <= 7; days++) overdue.push(await item(team, `Overdue ${days}`, { deadline: daysAgo(days) }));
      await item(team, "Done late", { deadline: daysAgo(3), completed: true });
      await item(team, "Past event", { startsAt: daysAgo(3), endsAt: daysAgo(2.9) });
      await item(team, "Due later", { deadline: new Date(Date.now() + 3 * 86_400_000).toISOString() });
      await item(other, "Overdue elsewhere", { deadline: daysAgo(2) });
      const mine = await item(team, "Mine", { assignee: memberId });
      const urgent = await item(team, "Mine and urgent", { assignee: memberId, priority: "urgent" });
      await item(team, "Theirs", { assignee: colleagueId });
      await item(team, "Nobody's", {});
      await item(team, "Mine but done", { assignee: memberId, completed: true });
      // A task planned into a time slot shows in the calendar, so the tray leaves it out, late or without a deadline.
      const slot = { startsAt: new Date(Date.now() + 3_600_000).toISOString(), endsAt: new Date(Date.now() + 7_200_000).toISOString() };
      await item(team, "Late but planned", { deadline: daysAgo(4), ...slot });
      await item(team, "Mine and planned", { assignee: memberId, ...slot });

      const loaded = await accounts.users.get({ id: memberId });
      if (!loaded) throw new Error("Missing fixture user");
      const token = await serviceAccountCredentials.createUserApiToken({
        user: loaded,
        browserSignIn: await createTestBrowserSignIn(loaded.id),
        name: "Member key",
      });
      if (!token.ok) throw new Error(token.error.message);
      const view = async (query: string) => {
        const href = encodeURIComponent(`/app/spaces/${team.short_id}?view=calendar&${query}`);
        const response = await spacesApi.request(`/workspace/view?href=${href}`, {
          headers: { authorization: `Bearer ${token.data.token}` },
        });
        expect(response.status).toBe(200);
        return ((await response.json()) as Snapshot).tray;
      };

      const tray = await view("cv=day");
      expect(tray?.overdue.items.map((entry) => entry.id)).toEqual(overdue.slice(0, 5));
      expect(tray?.overdue.total).toBe(6);
      expect(tray?.undated).toEqual({ items: [expect.objectContaining({ id: urgent }), expect.objectContaining({ id: mine })], total: 2 });

      // The tray follows the calendar's filter: no tasks while it shows events, none of the reader's for unassigned ones.
      expect(await view("cv=day&ctype=event")).toBeNull();
      const unassigned = await view("cv=day&cassigned=unassigned");
      expect(unassigned?.overdue.total).toBe(6);
      expect(unassigned?.undated).toEqual({ items: [], total: 0 });
      expect((await view("cv=day&cpriority=urgent"))?.overdue.total).toBe(0);
      // Only the day view has a tray.
      expect(await view("cv=week")).toBeNull();
      expect(await view("cv=month")).toBeNull();
    } finally {
      for (const id of spaceIds) await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
      for (const id of userIds) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id IN (
          SELECT id FROM auth.service_accounts WHERE delegated_user_id = ${id}::uuid)`;
        await sql`DELETE FROM auth.service_accounts WHERE delegated_user_id = ${id}::uuid`;
        await sql`DELETE FROM auth.access WHERE user_id = ${id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
      }
    }
  });
});
