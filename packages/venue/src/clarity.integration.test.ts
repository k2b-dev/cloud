import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { coreSettings, settings } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { dates } from "@k2b/stdlib";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import apiRoutes from "./api";
import type { PublicSection, PublicStatus, ShiftAssignment, ShiftTemplate, VenueDashboard } from "./contracts";
import { venueMessages } from "./messages";
import { venueService } from "./service";

const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(30_000);

const venueApp = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .route("/api/venue", apiRoutes);

const send = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, cookie: string | null, body?: unknown) =>
  venueApp.request(path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-forwarded-for": uniqueCallerAddress(),
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

/** The date key `days` calendar days after `date`. */
const shiftDate = (date: string, days: number): string =>
  new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + days, 12))
    .toISOString()
    .slice(0, 10);

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

  test("a sign-up answers with the name of the person and the shift", async () => {
    const created = await send("POST", `/api/venue/venues/${venueId}/templates`, cookie, {
      weekday: 3,
      title: "Morning counter",
      startTime: "08:00",
      endTime: "11:00",
      minPeople: 1,
      maxPeople: 4,
    });
    const template = await json<ShiftTemplate>(created, 201, "create template");
    // A Wednesday at least a week ahead in the Venue's time zone.
    let date = shiftDate(dates.formatDateKey(new Date(), { timeZone: "Europe/Berlin" }), 7);
    while (new Date(`${date}T12:00:00Z`).getUTCDay() !== 3) date = shiftDate(date, 1);
    const signup = (path: string, body: unknown) => send("POST", `/api/venue/venues/${venueId}/${path}`, cookie, body);

    const single = await json<ShiftAssignment>(await signup(`templates/${template.id}/signup`, { date }), 201, "sign up");
    expect(single).toMatchObject({ userDisplayName: "Venue clarity admin", templateTitle: "Morning counter" });

    const weeks = await json<ShiftAssignment[]>(
      await signup(`templates/${template.id}/signup-weeks`, { date: shiftDate(date, 7), weeks: 2 }),
      201,
      "sign up for two weeks",
    );
    expect(weeks.map((entry) => entry.userDisplayName)).toEqual(["Venue clarity admin", "Venue clarity admin"]);
    expect(weeks.map((entry) => entry.templateTitle)).toEqual(["Morning counter", "Morning counter"]);
    // Weeks the person already has are skipped; the dialog reads the empty answer as "nothing added".
    const again = await signup(`templates/${template.id}/signup-weeks`, { date: shiftDate(date, 7), weeks: 2 });
    expect(await json<ShiftAssignment[]>(again, 201, "sign up for the same weeks again")).toEqual([]);

    const startsAt = new Date(`${shiftDate(date, 1)}T15:00:00Z`).toISOString();
    const endsAt = new Date(`${shiftDate(date, 1)}T17:00:00Z`).toISOString();
    const free = await json<ShiftAssignment>(await signup("free-signup", { startsAt, endsAt, note: null }), 201, "free sign-up");
    expect(free).toMatchObject({ userDisplayName: "Venue clarity admin", templateTitle: null });

    // Deleting a template only deactivates it; the person's shift keeps its name instead of turning into free time.
    expect((await send("DELETE", `/api/venue/venues/${venueId}/templates/${template.id}`, cookie)).status).toBe(200);
    const board = await json<VenueDashboard>(await send("GET", `/api/venue/venues/${venueId}/dashboard`, cookie), 200, "dashboard");
    expect(board.templates.some((entry) => entry.id === template.id)).toBe(false);
    const mine = board.myUpcomingShifts.find((entry) => entry.id === single.id);
    expect(mine).toMatchObject({ templateId: template.id, templateTitle: "Morning counter" });
    expect(board.myUpcomingShifts.find((entry) => entry.id === free.id)?.templateTitle).toBeNull();
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

    // "Only with comment" narrows the list and its total to the rated comments; the figures stay the window's.
    const withComment = await dashboard("&feedbackComments=true");
    expect(withComment.feedback).toMatchObject({ count: 120, commentCount: 40 });
    expect(withComment.feedbackEntriesPage).toEqual({ page: 1, pageSize: 50, total: 40 });
    expect(withComment.feedbackEntries).toHaveLength(40);
    expect(withComment.feedbackEntries.every((entry) => entry.comment)).toBe(true);
    const commentedSearch = await dashboard("&feedbackComments=true&feedbackSearch=note%201");
    expect(commentedSearch.feedbackEntriesPage?.total).toBe(commentedSearch.feedbackEntries.length);
    expect(commentedSearch.feedbackEntries.every((entry) => entry.comment?.includes("note 1"))).toBe(true);

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

  test("the public status lists staffed openings without the internal template title", async () => {
    // A shift with a title only staff should see, taken for its next occurrence within the public 14-day window.
    const tomorrow = shiftDate(dates.formatDateKey(new Date(), { timeZone: "Europe/Berlin" }), 1);
    const created = await send("POST", `/api/venue/venues/${venueId}/templates`, cookie, {
      weekday: new Date(`${tomorrow}T12:00:00Z`).getUTCDay(),
      title: "Crew Z backroom rota",
      startTime: "17:00",
      endTime: "21:00",
      minPeople: 1,
      maxPeople: 2,
    });
    const template = await json<ShiftTemplate>(created, 201, "create internal template");
    await json(
      await send("POST", `/api/venue/venues/${venueId}/templates/${template.id}/signup`, cookie, { date: tomorrow }),
      201,
      "take it",
    );

    const response = await send("GET", `/api/venue/public/${venueId}/status`, null);
    const raw = await response.clone().text();
    const status = await json<PublicStatus>(response, 200, "public status");
    const opening = status.upcomingOpenings.find((entry) => entry.kind === "shift");
    expect(opening).toMatchObject({ title: "Additionally open" });
    expect(raw).not.toContain("Crew Z backroom rota");
  });

  test("renewing the calendar link retires the old subscription URL", async () => {
    const path = (href: string) => new URL(href).pathname;
    const current = await json<{ href: string }>(await send("GET", "/api/venue/calendar/my", cookie), 200, "calendar link");
    // A calendar app needs an absolute URL, even when `app.url` is configured without a scheme.
    expect(current.href).toMatch(/^https?:\/\/[^/]+\/api\/venue\/calendar\//);
    expect((await send("GET", path(current.href), null)).status).toBe(200);

    const renewed = await json<{ href: string }>(await send("POST", "/api/venue/calendar/my/renew", cookie), 200, "renew");
    expect(renewed.href).not.toBe(current.href);
    expect(path(renewed.href)).toMatch(/^\/api\/venue\/calendar\/[0-9a-f]{48}\.ics$/);
    expect((await send("GET", path(current.href), null)).status).toBe(404);
    const feed = await send("GET", path(renewed.href), null);
    expect(feed.status).toBe(200);
    expect(await feed.text()).toContain("BEGIN:VCALENDAR");
    // The link the workspace shows next is the renewed one.
    expect((await json<{ href: string }>(await send("GET", "/api/venue/calendar/my", cookie), 200, "calendar link again")).href).toBe(
      renewed.href,
    );

    // Renewing needs a signed-in person.
    expect((await send("POST", "/api/venue/calendar/my/renew", null)).status).toBe(401);
  });

  test("the calendar feed names shifts in the Cloud's default language", async () => {
    const template = await json<ShiftTemplate>(
      await send("POST", `/api/venue/venues/${venueId}/templates`, cookie, {
        weekday: 5,
        title: "Evening bar",
        startTime: "18:00",
        endTime: "22:00",
        minPeople: 1,
        maxPeople: 2,
      }),
      201,
      "create template",
    );
    let date = shiftDate(dates.formatDateKey(new Date(), { timeZone: "Europe/Berlin" }), 1);
    while (new Date(`${date}T12:00:00Z`).getUTCDay() !== 5) date = shiftDate(date, 1);
    await json(await send("POST", `/api/venue/venues/${venueId}/templates/${template.id}/signup`, cookie, { date }), 201, "sign up");
    const startsAt = new Date(`${shiftDate(date, 1)}T08:00:00Z`).toISOString();
    const endsAt = new Date(`${shiftDate(date, 1)}T10:00:00Z`).toISOString();
    await json(
      await send("POST", `/api/venue/venues/${venueId}/free-signup`, cookie, { startsAt, endsAt, note: "Bring the keys" }),
      201,
      "free sign-up",
    );

    const events = (feed: string) =>
      feed
        .split("BEGIN:VEVENT")
        .slice(1)
        .map((event) => ({
          summary: /^SUMMARY:(.*)$/m.exec(event)?.[1],
          description: /^DESCRIPTION:(.*)$/m.exec(event)?.[1],
          url: /^URL:(.*)$/m.exec(event)?.[1],
        }));
    const feedFor = async (locale: string) =>
      events(await venueService.ical.generateUser(admin.id, "cloud.example.test", locale)).filter((event) =>
        ["Evening bar", "Free time\\nBring the keys", "Freier Zeitraum\\nBring the keys"].includes(event.description ?? ""),
      );
    const url = `https://cloud.example.test/app/venue/${venueId}`;
    expect(await feedFor("en")).toEqual([
      { summary: "Shift at Harbor Cafe", description: "Evening bar", url },
      { summary: "Shift at Harbor Cafe", description: "Free time\\nBring the keys", url },
    ]);
    expect(await feedFor("de-DE")).toEqual([
      { summary: "Schicht bei Harbor Cafe", description: "Evening bar", url },
      { summary: "Schicht bei Harbor Cafe", description: "Freier Zeitraum\\nBring the keys", url },
    ]);

    // A calendar app fetches the feed without a locale, so the route uses `app.locale`.
    const { href } = await json<{ href: string }>(await send("GET", "/api/venue/calendar/my", cookie), 200, "calendar link");
    const feed = await (await send("GET", new URL(href).pathname, null)).text();
    const expected = venueMessages.resolve([await coreSettings.get<string>("app.locale")]).t.calendarEventTitle({ venue: "Harbor Cafe" });
    expect(events(feed).map((event) => event.summary)).toContain(expected);
  });
});
