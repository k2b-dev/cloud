import { afterAll, beforeAll, expect } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { ADMIN_ACTIVITY_DAYS, adminActivity, adminSummary, adminWriters } from "./notebooks";

const postgresTest = testFor("database");
// one moment for every read: 26.11.2026, 11:00 in Berlin (CET, UTC+1)
const now = new Date("2026-11-26T10:00:00.000Z");
const timeZone = "Europe/Berlin";
const tag = `admin-activity-${crypto.randomUUID().slice(0, 8)}`;
const busy = crypto.randomUUID();
const old = crypto.randomUUID();
const never = crypto.randomUUID();
const ada = crypto.randomUUID();
const ben = crypto.randomUUID();
const adaAccess = crypto.randomUUID();
const benAccess = crypto.randomUUID();

const event = (notebookId: string, at: string, occurrences: number, actor: string | null = null) =>
  sql`
    INSERT INTO notebooks.activity_events (notebook_id, actor_kind, actor_id, action, occurrence_count, created_at, last_occurred_at)
    VALUES (${notebookId}::uuid, ${actor ? "user" : "system"}, ${actor}::uuid, 'note.edited', ${occurrences}, ${at}::timestamptz, ${at}::timestamptz)
  `;

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  for (const [id, name] of [
    [ada, "Ada Renz"],
    [ben, "Ben Ochs"],
  ]) {
    await sql`INSERT INTO auth.users (id, uid, display_name, provider, profile) VALUES (${id}::uuid, ${`${tag}-${id}`}, ${name}, 'local', 'user')`;
  }
  await sql`
    INSERT INTO notebooks.notebooks (id, name)
    VALUES (${busy}::uuid, ${`${tag} A busy`}), (${old}::uuid, ${`${tag} B old`}), (${never}::uuid, ${`${tag} C never`})
  `;
  await sql`INSERT INTO notebooks.notes (id, notebook_id, title) VALUES (${crypto.randomUUID()}::uuid, ${busy}::uuid, 'One'), (${crypto.randomUUID()}::uuid, ${busy}::uuid, 'Two')`;
  // only the busy notebook can be reached: by Ben and Ada, the people in name order
  await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${adaAccess}::uuid, ${ada}::uuid, 'admin'), (${benAccess}::uuid, ${ben}::uuid, 'read')`;
  await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${busy}::uuid, ${benAccess}::uuid), (${busy}::uuid, ${adaAccess}::uuid)`;
  // today in Berlin, also 00:30 local, which is still yesterday in UTC
  await event(busy, "2026-11-26T09:00:00Z", 3, ada);
  await event(busy, "2026-11-25T23:30:00Z", 2, ben);
  await event(busy, "2026-11-20T12:00:00Z", 1);
  // the window's first day starts at 28.10. 00:00 in Berlin; one minute before it is outside
  await event(busy, "2026-10-27T23:00:00Z", 4, ada);
  await event(busy, "2026-10-27T22:59:00Z", 7, ben);
  await event(old, "2026-10-01T08:00:00Z", 5);
});

afterAll(async () => {
  if (!testInfra.database) return;
  await sql`DELETE FROM notebooks.notebooks WHERE id = ANY(ARRAY[${busy}::uuid, ${old}::uuid, ${never}::uuid])`;
  await sql`DELETE FROM auth.access WHERE id = ANY(ARRAY[${adaAccess}::uuid, ${benAccess}::uuid])`;
  await sql`DELETE FROM auth.users WHERE id = ANY(ARRAY[${ada}::uuid, ${ben}::uuid])`;
});

postgresTest("reads a page's notes, changes per calendar day of the viewer, last change and first access in one statement", async () => {
  const items = new Map((await adminActivity({ notebookIds: [busy, old, never], timeZone, now })).map((item) => [item.notebookId, item]));
  const today = ADMIN_ACTIVITY_DAYS - 1;
  const busyDays = items.get(busy)?.changesPerDay ?? [];
  expect(busyDays).toHaveLength(ADMIN_ACTIVITY_DAYS);
  expect(busyDays[today]).toBe(5);
  expect(busyDays[today - 6]).toBe(1);
  expect(busyDays[0]).toBe(4);
  expect(busyDays.reduce((total, value) => total + value, 0)).toBe(10);
  expect(items.get(busy)).toMatchObject({ noteCount: 2, lastActivityAt: "2026-11-26T09:00:00.000Z" });
  expect(items.get(busy)?.access.map((principal) => [principal.kind, principal.name])).toEqual([
    ["user", "Ada Renz"],
    ["user", "Ben Ochs"],
  ]);
  // a change before the window counts as the last change, but not in the days
  expect(items.get(old)).toMatchObject({
    noteCount: 0,
    lastActivityAt: "2026-10-01T08:00:00.000Z",
    changesPerDay: Array(ADMIN_ACTIVITY_DAYS).fill(0),
    access: [],
  });
  expect(items.get(never)).toMatchObject({ lastActivityAt: null, changesPerDay: Array(ADMIN_ACTIVITY_DAYS).fill(0), access: [] });
  expect(await adminActivity({ notebookIds: [], timeZone, now })).toEqual([]);
});

postgresTest("counts the matching notebooks used per day and names the exceptions by name", async () => {
  const summary = await adminSummary({ search: tag, timeZone, now });
  expect(summary).toMatchObject({ total: 3, orphaned: 2, totalPermissions: 2, active: 1 });
  expect(summary.activePerDay).toHaveLength(ADMIN_ACTIVITY_DAYS);
  // the busy notebook on three days: the first, the sixth before today, and today
  expect(summary.activePerDay.reduce((total, value) => total + value, 0)).toBe(3);
  expect(summary.activePerDay.at(-1)).toBe(1);
  expect(summary.orphanedNames).toEqual([`${tag} B old`, `${tag} C never`]);
  expect(summary.quietNames).toEqual([`${tag} B old`, `${tag} C never`]);
});

postgresTest("names who wrote in a notebook in the last 30 days, most changes first, without the system", async () => {
  const writers = await adminWriters({ notebookId: busy, timeZone, now });
  // Ben's 7 changes lie before the window; Ada's 4 on its first day count
  expect(writers.map((writer) => [writer.name, writer.changes])).toEqual([
    ["Ada Renz", 7],
    ["Ben Ochs", 2],
  ]);
  expect(writers[0]?.lastAt).toBe("2026-11-26T09:00:00.000Z");
  expect(await adminWriters({ notebookId: never, timeZone, now })).toEqual([]);
});

postgresTest("each read of the administration is one statement; an empty page reads nothing", async () => {
  const meter = await meterSql();
  try {
    // the hero and its exceptions, a page of rows, an open notebook's writers
    expect(await meter.during(() => adminSummary({ search: tag, timeZone, now }))).toHaveLength(1);
    expect(await meter.during(() => adminActivity({ notebookIds: [busy, old, never], timeZone, now }))).toHaveLength(1);
    expect(await meter.during(() => adminWriters({ notebookId: busy, timeZone, now }))).toHaveLength(1);
    expect(await meter.during(() => adminActivity({ notebookIds: [], timeZone, now }))).toEqual([]);
  } finally {
    await meter.close();
  }
});
