import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { settings } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import apiRoutes from "./api";
import type { PublicSection, PublicStatus, ShiftTemplate, VenueDashboard } from "./contracts";
import { venueService } from "./service";

const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(30_000);

const venueApp = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .route("/api/venue", apiRoutes);

const send = (method: "GET" | "POST" | "PATCH", path: string, cookie: string | null, body?: unknown) =>
  venueApp.request(path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const json = async <T>(response: Response, status: number, label: string): Promise<T> => {
  const text = await response.text();
  expect({ label, status: response.status, body: response.status === status ? "" : text.slice(0, 2_000) }).toEqual({
    label,
    status,
    body: "",
  });
  return JSON.parse(text) as T;
};

const insertUser = async (): Promise<User> => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`venue-clarity-${suffix}`}, 'local', 'user', 'Venue clarity admin', ${`venue-clarity-${suffix}@example.test`})
    RETURNING id
  `;
  return { id: row!.id } as User;
};

suite("Venue sections and feedback say what they do", () => {
  let admin: User;
  let cookie: string;
  let venueId: string;

  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
    admin = await insertUser();
    cookie = `session_token=${await createTestSession(admin.id)}`;
    const created = await send("POST", "/api/venue/venues", cookie, {
      name: "Harbor Cafe",
      slug: `harbor-cafe-${admin.id.slice(0, 8)}`,
      timezone: "Europe/Berlin",
    });
    venueId = (await json<{ id: string }>(created, 201, "create venue")).id;
  });

  afterAll(async () => {
    await sql`
      DELETE FROM venue.venues WHERE id IN (
        SELECT va.venue_id FROM venue.venue_access va JOIN auth.access a ON a.id = va.access_id WHERE a.user_id = ${admin.id}::uuid
      )
    `;
    await sql`DELETE FROM auth.users WHERE id = ${admin.id}::uuid`;
  });

  test("editing a section changes only the fields sent, so a draft stays a draft in place", async () => {
    const created = await send("POST", `/api/venue/venues/${venueId}/sections`, cookie, {
      kind: "notice",
      title: "Draft: winter hours",
      content: { text: "Closed on Fridays" },
      enabled: false,
      position: 5,
    });
    const draft = await json<PublicSection>(created, 201, "create draft");
    const patch = (body: unknown) => send("PATCH", `/api/venue/venues/${venueId}/sections/${draft.id}`, cookie, body);
    const publicSections = async () =>
      (await json<PublicStatus>(await send("GET", `/api/venue/public/${venueId}/status`, null), 200, "public status")).sections.map(
        (section) => section.id,
      );

    // What `cld venue sections update <venue> <id> --title ...` sends.
    const renamed = await json<PublicSection>(await patch({ title: "Winter hours" }), 200, "rename draft");
    expect(renamed).toMatchObject({ title: "Winter hours", enabled: false, position: 5, content: { text: "Closed on Fridays" } });
    expect(await publicSections()).not.toContain(draft.id);

    const published = await json<PublicSection>(await patch({ enabled: true }), 200, "publish draft");
    expect(published).toMatchObject({ title: "Winter hours", enabled: true, position: 5 });
    expect(await publicSections()).toContain(draft.id);

    // The merged section is validated as a whole: a menu needs items.
    const invalid = await patch({ kind: "menu" });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { message: string }).message).toContain("content.items");
  });

  test("a shift window across the autumn clock change still sees who took its last evening's shifts", async () => {
    // Berlin leaves summer time on Sunday 2025-10-26, so the 14 days from 2025-10-13 last 14 days and one hour.
    const created = await send("POST", `/api/venue/venues/${venueId}/templates`, cookie, {
      weekday: 0,
      title: "Late close",
      startTime: "23:00",
      endTime: "23:30",
      minPeople: 1,
      maxPeople: 1,
    });
    const template = await json<ShiftTemplate>(created, 201, "create template");
    const [row] = await sql<{ venue_id: string; template_id: string }[]>`
      SELECT venue_id::text, id::text AS template_id FROM venue.shift_templates WHERE short_id = ${template.id}
    `;
    const shortId = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
    // 23:00 in Berlin on 2025-10-26 is 22:00 UTC.
    await sql`
      INSERT INTO venue.shift_assignments (short_id, venue_id, template_id, user_id, starts_at, ends_at)
      VALUES (${shortId}, ${row!.venue_id}::uuid, ${row!.template_id}::uuid, ${admin.id}::uuid, '2025-10-26T22:00:00Z', '2025-10-26T22:30:00Z')
    `;

    const board = await json<VenueDashboard>(
      await send("GET", `/api/venue/venues/${venueId}/dashboard?slotStartDate=2025-10-13&slotDays=14`, cookie),
      200,
      "dashboard across the clock change",
    );
    expect(board.slots.find((slot) => slot.template.id === template.id && slot.date === "2025-10-26")).toMatchObject({
      assignedCount: 1,
      full: true,
    });

    // Capabilities read shifts through the summary, which builds the same window.
    const venue = await venueService.venues.get(row!.venue_id);
    const summaries = await venueService.shifts.listSummary(venue!, { startDate: "2025-10-13", days: 14 });
    expect(summaries.find((slot) => slot.template.title === "Late close" && slot.date === "2025-10-26")).toMatchObject({
      assignedCount: 1,
      full: true,
    });
  });

  test("feedback counts, pages, and list totals cover the same window", async () => {
    const [venue] = await sql<{ id: string }[]>`SELECT id::text FROM venue.venues WHERE short_id = ${venueId}`;
    // 120 ratings in the last 30 days, every third with a comment, plus one older rating outside the window.
    for (let index = 0; index < 120; index += 1) {
      await sql`
        INSERT INTO venue.feedback_entries (venue_id, rating, comment, created_at)
        VALUES (${venue!.id}::uuid, ${1 + (index % 5)}, ${index % 3 === 0 ? `Espresso note ${index}` : null}, now() - (${index * 5}::text || ' hours')::interval)
      `;
    }
    await sql`
      INSERT INTO venue.feedback_entries (venue_id, rating, comment, created_at)
      VALUES (${venue!.id}::uuid, 1, 'Espresso long ago', now() - interval '45 days')
    `;
    const dashboard = async (query: string) =>
      json<VenueDashboard>(
        await send("GET", `/api/venue/venues/${venueId}/dashboard?includeFeedbackEntries=true&feedbackDays=30${query}`, cookie),
        200,
        `dashboard ${query}`,
      );

    const first = await dashboard("");
    expect(first.feedback).toMatchObject({ count: 120, commentCount: 40 });
    expect(first.feedback!.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(120);
    expect(first.feedbackEntriesPage).toEqual({ page: 1, pageSize: 50, total: 120 });
    expect(first.feedbackEntries).toHaveLength(50);

    const last = await dashboard("&feedbackPage=3");
    expect(last.feedbackEntriesPage).toEqual({ page: 3, pageSize: 50, total: 120 });
    expect(last.feedbackEntries).toHaveLength(20);
    const seen = new Set(
      [...first.feedbackEntries, ...(await dashboard("&feedbackPage=2")).feedbackEntries, ...last.feedbackEntries].map(
        (entry) => entry.createdAt,
      ),
    );
    expect(seen.size).toBe(120);

    // A page past the end shows the last page instead of an empty table.
    expect((await dashboard("&feedbackPage=99")).feedbackEntriesPage?.page).toBe(3);

    // A search narrows the list, not the window's counts.
    const searched = await dashboard("&feedbackSearch=espresso");
    expect(searched.feedback).toMatchObject({ count: 120, commentCount: 40 });
    expect(searched.feedbackEntriesPage?.total).toBe(40);
    expect(searched.feedbackEntries.every((entry) => entry.comment?.startsWith("Espresso note"))).toBe(true);

    // Without entries there is no list to place, so no page claims a total of zero next to 120 ratings.
    const summaryOnly = await json<VenueDashboard>(
      await send("GET", `/api/venue/venues/${venueId}/dashboard`, cookie),
      200,
      "summary only",
    );
    expect(summaryOnly.feedback).toMatchObject({ count: 120 });
    expect(summaryOnly.feedbackEntries).toEqual([]);
    expect(summaryOnly.feedbackEntriesPage).toBeNull();
  });
});
