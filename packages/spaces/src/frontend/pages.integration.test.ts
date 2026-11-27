import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@k2b/cloud";
import { CalendarEventsDataSchema, CalendarListDataSchema, type CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { toPgTextArray, toPgUuidArray, weatherService } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import * as layoutHelp from "@k2b/cloud/ssr/help";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { orderBoardColumns } from "../board-columns";
import { migrate } from "../migrate";
import { spacesService } from "../service";
import { listSourceCalendars, readSourceEvents } from "../service/calendar-source";
import * as calendarView from "../service/calendar-view";
import * as estimate from "../service/estimate-suggestion";
import * as mailIntegration from "../service/mail-integration";
import { defaultFilter } from "./[id]/_components/filter/types";
import { kanbanBucketFilter } from "./[id]/_components/kanban/bucket-filter";

// Every Spaces page on its real path: the route, the page loader, the Cloud layout and the islands' props in the HTML.
// Each first view costs a pinned number of statements, the same for a small and a large fixture (no read per row,
// Space, member or board column), carries no loading indicator, and its island props stay within a measured size.
const root = mkdtempSync(join(tmpdir(), "spaces-pages-integration-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: pages, adminPages } = await import("./index");

const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(240_000);

/** The fixture's moment: every date below is relative to it, so each day the pages show the same picture. */
// real clock: sessions and their cache expire on the server's clock, so the pages run at the real time.
const NOW = new Date().toISOString();
const DATE_CONTEXT = { locale: "en", timeZone: "UTC" };
const origin = "https://cloud.example.test";
const shortId = sql`substr(translate(encode(gen_random_bytes(6), 'base64'), '+/=', 'xyz'), 1, 6)`;
const users: string[] = [];
const spaces: string[] = [];

const server = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
server.use("*", async (c, next) => {
  c.set("runtime", { apps: [] });
  await next();
});
server.route("/app/spaces", pages).route("/admin/spaces", adminPages);

/** The reader whose Spaces the calendar's source stand-in reads; a capability call runs these reads inside Spaces. */
let reader = "";
const sourceContext = () => ({ subject: { type: "user" as const, userId: reader }, dateConfig: DATE_CONTEXT });

const person = async (name: string, admin = false) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, admin)
    VALUES (${`spaces-pages-${crypto.randomUUID()}`}, 'local', 'user', ${name}, ${admin}) RETURNING id`;
  users.push(row!.id);
  return row!.id;
};

type Scale = { name: string; spaces: number; perColumn: number; tags: number; members: number; comments: number; events: number };
const USUAL: Scale = { name: "usual", spaces: 6, perColumn: 8, tags: 5, members: 3, comments: 4, events: 12 };
const WORST: Scale = { name: "worst", spaces: 100, perColumn: 120, tags: 30, members: 40, comments: 50, events: 200 };
const COLUMNS = ["Backlog", "Planned", "In progress", "Review", "Waiting", "Done"];

/** A reader who administers `scale.spaces` Spaces; the first has six columns, the second one column. */
const seed = async (scale: Scale) => {
  const long = scale.name === "worst";
  const id = await person(long ? "Maximiliane Alexandra von Musterhausen-Beispielstein" : "Robin Example");
  const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission) VALUES (${id}::uuid, 'admin') RETURNING id`;
  const title = long ? "Prepare the quarterly inventory count for the northern warehouse and agree the dates with every team lead" : "Task";
  const rows = await sql<{ id: string; short_id: string }[]>`
    INSERT INTO spaces.spaces (short_id, name, description, color)
    SELECT ${shortId}, ${long ? "Customer service north and the regional partner network" : "Space"} || ' ' || n,
      ${long ? "Everything the regional customer service teams plan, track and hand over, including partner escalations and weekly reviews." : "Team work"},
      (ARRAY['#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6'])[1 + n % 4]
    FROM generate_series(1, ${scale.spaces}) AS n
    ORDER BY n
    RETURNING id, short_id`;
  const ids = rows.map((row) => row.id);
  spaces.push(...ids);
  const [main, single] = rows as [{ id: string; short_id: string }, { id: string; short_id: string }];
  await sql`INSERT INTO spaces.space_access (space_id, access_id)
    SELECT space_id, ${access!.id}::uuid FROM unnest(${toPgUuidArray(ids)}::uuid[]) AS space_id`;
  // Members of the main Space, so its settings and its people list are as long as the scale says.
  for (let index = 0; index < scale.members; index++) {
    const member = await person(`Member ${index + 1} ${long ? "Ångström-Østergaard" : ""}`.trim());
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission) VALUES (${member}::uuid, 'write') RETURNING id`;
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${main.id}::uuid, ${grant!.id}::uuid)`;
  }
  // Six columns in the main Space (the last one done), one column in every other Space.
  const columns = await sql<{ id: string }[]>`
    INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
    SELECT ${shortId}, ${main.id}::uuid, name, position * 1024, position = ${COLUMNS.length}
    FROM unnest(${toPgTextArray(COLUMNS)}::text[]) WITH ORDINALITY AS c(name, position)
    ORDER BY position
    RETURNING id`;
  await sql`INSERT INTO spaces.columns (short_id, space_id, name, rank)
    SELECT ${shortId}, id, 'Open', 1024 FROM spaces.spaces WHERE id = ANY(${toPgUuidArray(ids.slice(1))}::uuid[])`;
  await sql`INSERT INTO spaces.tags (short_id, space_id, name, color)
    SELECT ${shortId}, ${main.id}::uuid, ${long ? "Partner escalation" : "Tag"} || ' ' || n, '#6366f1' FROM generate_series(1, ${scale.tags}) AS n`;
  const columnIds = columns.map((column) => column.id);
  // Both automatic board columns, so the board reads eight lists: overdue and blocked tasks gather there.
  await sql`INSERT INTO spaces.virtual_columns (space_id, kind, rank) VALUES (${main.id}::uuid, 'overdue', 512), (${main.id}::uuid, 'blocked', 768)`;
  // Tasks across the six columns: some overdue, some due today, some later, some without a date; the done column's
  // tasks were finished over the last two weeks.
  await sql`
    INSERT INTO spaces.items (short_id, space_id, column_id, title, priority, deadline, rank, completed_at, created_at, updated_at)
    SELECT ${shortId}, ${main.id}::uuid, (${toPgUuidArray(columnIds)}::uuid[])[1 + (n - 1) % 6], ${title} || ' ' || n,
      (ARRAY['low', 'medium', 'high', 'urgent', NULL])[1 + n % 5],
      CASE WHEN n % 4 <> 0 THEN ${NOW}::timestamptz + ((n % 21) - 7) * interval '1 day' END,
      n * 1024,
      CASE WHEN (n - 1) % 6 = 5 THEN ${NOW}::timestamptz - (n % 14) * interval '1 day' END,
      ${NOW}::timestamptz - n * interval '1 hour', ${NOW}::timestamptz - n * interval '1 hour'
    FROM generate_series(1, ${COLUMNS.length * scale.perColumn}) AS n`;
  // Events this month in the main Space, three tasks in every other Space.
  await sql`
    INSERT INTO spaces.items (short_id, space_id, column_id, title, starts_at, ends_at, rank)
    SELECT ${shortId}, ${main.id}::uuid, ${columnIds[1]!}::uuid, ${long ? "Weekly review with the partner network and all regional leads" : "Meeting"} || ' ' || n,
      date_trunc('month', ${NOW}::timestamptz) + (n % 28) * interval '1 day' + (8 + n % 9) * interval '1 hour',
      date_trunc('month', ${NOW}::timestamptz) + (n % 28) * interval '1 day' + (9 + n % 9) * interval '1 hour',
      (100000 + n) * 1024
    FROM generate_series(1, ${scale.events}) AS n`;
  await sql`
    INSERT INTO spaces.items (short_id, space_id, column_id, title, deadline, rank)
    SELECT ${shortId}, c.space_id, c.id, ${title} || ' ' || n, ${NOW}::timestamptz + (n - 2) * interval '1 day', n * 1024
    FROM spaces.columns c CROSS JOIN generate_series(1, 3) AS n
    WHERE c.space_id = ANY(${toPgUuidArray(ids.slice(1))}::uuid[])`;
  // The reader holds every third task of the main Space, tasks carry tags, and every tenth waits on another.
  await sql`INSERT INTO spaces.item_assignees (item_id, user_id)
    SELECT id, ${id}::uuid FROM spaces.items WHERE space_id = ${main.id}::uuid AND (rank / 1024) % 3 = 0`;
  await sql`INSERT INTO spaces.item_tags (item_id, tag_id)
    SELECT i.id, t.id FROM spaces.items i
    JOIN LATERAL (SELECT id FROM spaces.tags WHERE space_id = i.space_id ORDER BY name OFFSET (i.rank / 1024) % ${scale.tags} LIMIT 2) t ON true
    WHERE i.space_id = ${main.id}::uuid AND (i.rank / 1024) % 2 = 0`;
  await sql`INSERT INTO spaces.item_dependencies (item_id, blocker_item_id)
    SELECT i.id, b.id FROM spaces.items i JOIN spaces.items b ON b.space_id = i.space_id AND b.rank = i.rank + 1024
    WHERE i.space_id = ${main.id}::uuid AND (i.rank / 1024) % 10 = 0 AND b.completed_at IS NULL`;
  // The open item: comments, a checklist and links.
  const [item] = await sql<{ id: string; short_id: string }[]>`
    SELECT id, short_id FROM spaces.items WHERE space_id = ${main.id}::uuid AND rank = 1024`;
  await sql`INSERT INTO spaces.comments (short_id, item_id, user_id, content, created_at)
    SELECT ${shortId}, ${item!.id}::uuid, ${id}::uuid, ${long ? "The partner confirmed the new delivery window; we still need the signed form before Friday, otherwise the count moves." : "Looks good."} || ' ' || n,
      ${NOW}::timestamptz - n * interval '10 minutes'
    FROM generate_series(1, ${scale.comments}) AS n`;
  await sql`INSERT INTO spaces.item_checklist_entries (short_id, item_id, label, rank)
    SELECT ${shortId}, ${item!.id}::uuid, 'Step ' || n, n * 1024 FROM generate_series(1, ${long ? 30 : 4}) AS n`;
  await sql`INSERT INTO spaces.item_links (item_id, url, label)
    SELECT ${item!.id}::uuid, 'https://docs.example.test/handbook/' || n, 'Handbook ' || n FROM generate_series(1, 3) AS n`;
  const cookie = `session_token=${await createTestSession(id)}`;
  return { id, cookie, main: main.short_id, mainId: main.id, single: single.short_id, item: item!.short_id };
};

/** Each island's props as the HTML carries them; their sum is what the browser parses before it hydrates. */
const islandBytes = (html: string) =>
  [...html.matchAll(/<solid-island\b[^>]*?\bdata-props="([^"]*)"/g)]
    .map((match) =>
      match[1]!.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
    )
    .reduce((sum, props) => sum + Buffer.byteLength(props), 0);

type Fixture = Awaited<ReturnType<typeof seed>>;
const paths = (fixture: Fixture) => ({
  home: "/app/spaces",
  "home today": "/app/spaces?view=today",
  "home upcoming": "/app/spaces?view=upcoming",
  list: `/app/spaces/${fixture.main}?view=list`,
  table: `/app/spaces/${fixture.main}?view=table`,
  kanban: `/app/spaces/${fixture.main}?view=kanban`,
  "kanban filtered": `/app/spaces/${fixture.main}?view=kanban&assignedTo=me`,
  "kanban one column": `/app/spaces/${fixture.single}?view=kanban`,
  "kanban one column filtered": `/app/spaces/${fixture.single}?view=kanban&assignedTo=me`,
  month: `/app/spaces/${fixture.main}?view=calendar&cv=month`,
  week: `/app/spaces/${fixture.main}?view=calendar&cv=week`,
  day: `/app/spaces/${fixture.main}?view=calendar&cv=day`,
  "list with item": `/app/spaces/${fixture.main}?view=list&item=${fixture.item}`,
  settings: `/app/spaces/${fixture.main}/settings`,
  calendar: "/app/spaces/calendar",
});

/**
 * The pinned first-view cost of every page, the same for the usual and the worst fixture: no read per row, Space,
 * member or column. Every page pays the signed-in person and the shell's screen preferences; a Space page also its
 * sidebar (4), its pulse (1), its permission, detail, projections and the people it can assign. The board reads all
 * its columns in one batch: one count, one windowed page read and one hydration of 6, so 8 lists cost what 1 does
 * (before: 8 per column, up to twice that filtered). A filter that leaves a list empty skips its hydration.
 */
const STATEMENTS = {
  home: 11,
  "home today": 10,
  "home upcoming": 11,
  list: 42,
  table: 41,
  kanban: 41,
  "kanban filtered": 41,
  "kanban one column": 38,
  "kanban one column filtered": 29,
  month: 37,
  week: 37,
  day: 49,
  "list with item": 58,
  settings: 28,
  calendar: 20,
  admin: 16,
};

const measure = async (fixture: Fixture, admin: string) => {
  reader = fixture.id;
  const headers = (cookie: string) => ({ cookie, "x-forwarded-for": uniqueCallerAddress() });
  const open = async (path: string, cookie: string) => {
    const response = await server.request(`${origin}${path}`, { headers: headers(cookie) });
    expect({ path, status: response.status, location: response.headers.get("location") }).toEqual({ path, status: 200, location: null });
    return response.text();
  };
  const targets = [
    ...Object.entries(paths(fixture)).map(([name, path]) => ({ name, path, cookie: fixture.cookie })),
    { name: "admin", path: "/admin/spaces", cookie: admin },
  ];
  // The session, the settings and the catalogs are warm, as on every running server.
  for (const target of targets) await open(target.path, target.cookie);
  const statements: Record<string, number> = {};
  const bytes: Record<string, number> = {};
  const loading: Record<string, number> = {};
  const meter = await meterSql();
  try {
    for (const target of targets) {
      let html = "";
      const read = await meter.during(async () => {
        html = await open(target.path, target.cookie);
      });
      statements[target.name] = read.length;
      bytes[target.name] = islandBytes(html);
      loading[target.name] = html.split('data-k2-part="Loading"').length - 1;
    }
  } finally {
    await meter.close();
  }
  return { statements, bytes, loading };
};

suite("every Spaces page's first view (integration)", () => {
  const stubs: { mockRestore(): void }[] = [];
  let admin = "";
  let adminCookie = "";
  const results: Record<string, Awaited<ReturnType<typeof measure>>> = {};

  beforeAll(async () => {
    stubs.push(
      stubRailSnapshot(),
      spyOn(layoutHelp, "preloadLayoutHelp").mockResolvedValue(null),
      // Other apps answer these over HTTP; they read nothing of Spaces.
      spyOn(mailIntegration, "isMailInvitationIntegrationAvailable").mockResolvedValue(false),
      spyOn(estimate, "isEstimateSuggestionAvailable").mockResolvedValue(false),
      spyOn(weatherService.forecast, "get").mockResolvedValue(null),
      // Core forwards the calendar's reads to each app; Spaces answers them with its own source, as here.
      spyOn(calendarView, "loadCalendarSources").mockImplementation(async () => [
        {
          appId: "spaces",
          name: "Spaces",
          icon: null,
          state: "ok",
          error: null,
          calendars: CalendarListDataSchema.parse(await listSourceCalendars({}, sourceContext())).items,
        },
      ]),
      spyOn(calendarView, "loadCalendarEvents").mockImplementation(async (_c, input) => ({
        items: CalendarEventsDataSchema.parse(
          await readSourceEvents({ calendarIds: input.calendars.map((entry) => entry.calendarId), from: input.from, to: input.to }, sourceContext()),
        ).items.map((item) => ({ ...item, appId: "spaces" })),
        sources: [{ appId: "spaces", state: "ok", error: null }],
      })),
    );
    admin = await person("Cloud Admin", true);
    adminCookie = `session_token=${await createTestSession(admin)}`;
  });

  afterAll(async () => {
    for (const stub of stubs) stub.mockRestore();
    for (const id of spaces) await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    console.info(`spaces pages: ${JSON.stringify(results)}`);
  });

  for (const scale of [USUAL, WORST])
    test(`${scale.name}: each page reads a pinned number of statements, shows no loading and keeps its props small`, async () => {
      const fixture = await seed(scale);
      const result = await measure(fixture, adminCookie);
      results[scale.name] = result;
      // A projection skips a lookup it has no IDs for: no task in the worst day's tray carries a tag.
      expect(result.statements).toEqual({ ...STATEMENTS, day: scale === USUAL ? 49 : 48 });
      // The props the browser parses before it hydrates; the worst month carries 680 entries of one Space.
      expect(Math.max(...Object.values(result.bytes))).toBeLessThan(scale === USUAL ? 100_000 : 800_000);
      expect(Object.values(result.loading).every((count) => count === 0)).toBe(true);

      // The board reads all its columns in one batch; each column gets what its own read returns, on every page,
      // filtered or not, automatic columns included.
      const detail = await spacesService.space.getDetail({ id: fixture.mainId });
      if (!detail) throw new Error("Missing fixture Space");
      const virtualKinds = new Set(detail.virtualColumns.map((virtual) => virtual.kind));
      const buckets = orderBoardColumns(detail.columns, detail.virtualColumns).map((entry) =>
        entry.kind === "column"
          ? { kind: "column" as const, columnId: entry.column.id, isDone: entry.column.isDone }
          : { kind: entry.kind, columnId: null, isDone: false },
      );
      expect(buckets).toHaveLength(8);
      const context = {
        spaceId: fixture.mainId,
        currentUserId: fixture.id,
        viewer: { kind: "user" as const, id: fixture.id },
        dateConfig: DATE_CONTEXT,
      };
      for (const filter of [defaultFilter, { ...defaultFilter, assignedTo: "me" as const }])
        for (const page of [1, 2]) {
          const lists = buckets.map((bucket) => kanbanBucketFilter({ bucket, virtualKinds, filter, page, pageSize: 30 }));
          const batch = await spacesService.item.listFilteredBatch({ ...context, lists: lists.map((list) => ({ filter: list })) });
          const single = await Promise.all(lists.map((list) => spacesService.item.listFiltered({ ...context, filter: list })));
          expect(batch.map((entry) => entry.result)).toEqual(single);
        }
    });

  // The test database ran every migration once already; a second run adds nothing and keeps the admin's name index.
  test("the migrations apply again cleanly and keep the administration's name index", async () => {
    await migrate();
    const [index] = await sql<{ definition: string }[]>`
      SELECT indexdef AS definition FROM pg_indexes WHERE schemaname = 'spaces' AND indexname = 'idx_spaces_name_lower'`;
    expect(index?.definition).toContain("(lower(name), created_at)");
  });
});
