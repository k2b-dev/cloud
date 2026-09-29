import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { settings } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { dates } from "@k2b/stdlib";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import apiRoutes from "./api";
import type { PublicStatus, ShiftTemplate, Venue, VenueDashboard } from "./contracts";
import "./frontend/ssr-test-plugin";
import { newShortId } from "./lib/short-id";

const { default: pageRoutes } = await import("./frontend");

const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(30_000);

const venueApp = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .route("/api/venue", apiRoutes)
  .route("/app/venue", pageRoutes);

const send = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, cookie: string, body?: unknown) =>
  venueApp.request(path, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const expectStatus = async (response: Response, status: number, label: string): Promise<string> => {
  const text = await response.text();
  expect({ label, status: response.status, body: response.status === status ? "" : text.slice(0, 2_000) }).toEqual({
    label,
    status,
    body: "",
  });
  return text;
};
const json = async <T>(response: Response, status: number, label: string): Promise<T> =>
  JSON.parse(await expectStatus(response, status, label)) as T;

type Person = { id: string; cookie: string };
const people: Person[] = [];
const insertPerson = async (label: string): Promise<Person> => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`venue-setup-${label}-${suffix}`}, 'local', 'user', ${`Venue ${label}`}, ${`venue-setup-${label}-${suffix}@example.test`})
    RETURNING id
  `;
  const person = { id: row!.id, cookie: `session_token=${await createTestSession(row!.id)}` };
  people.push(person);
  return person;
};

const shift = (weekday: number, overrides: Record<string, unknown> = {}) => ({
  weekday,
  title: "Morning counter",
  startTime: "09:00",
  endTime: "12:00",
  minPeople: 1,
  maxPeople: 2,
  ...overrides,
});

suite("Venue setup from the interface", () => {
  let admin: Person;
  let staff: Person;
  let slugPrefix: string;

  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
    admin = await insertPerson("admin");
    staff = await insertPerson("staff");
    slugPrefix = `setup-${admin.id.slice(0, 8)}`;
  });

  afterAll(async () => {
    await sql`
      DELETE FROM venue.venues WHERE id IN (
        SELECT va.venue_id FROM venue.venue_access va JOIN auth.access a ON a.id = va.access_id WHERE a.user_id = ${admin.id}::uuid
      )
    `;
    for (const person of people) await sql`DELETE FROM auth.users WHERE id = ${person.id}::uuid`;
  });

  /** A new venue by the admin, with the staff member granted `write`. */
  const createVenue = async (name: string, body: Record<string, unknown> = {}): Promise<Venue> => {
    const venue = await json<Venue>(
      await send("POST", "/api/venue/venues", admin.cookie, {
        name,
        slug: `${slugPrefix}-${name.toLowerCase().replace(/\W+/g, "-")}`,
        ...body,
      }),
      201,
      `create ${name}`,
    );
    await expectStatus(
      await send("POST", `/api/venue/venues/${venue.id}/access`, admin.cookie, {
        principal: { type: "user", userId: staff.id },
        permission: "write",
      }),
      201,
      "grant staff",
    );
    return venue;
  };
  const templatesOf = async (venueId: string) =>
    (await json<VenueDashboard>(await send("GET", `/api/venue/venues/${venueId}/dashboard`, admin.cookie), 200, "dashboard")).templates;

  test("creates a shift on several weekdays in one request, all or nothing, for admins only", async () => {
    const venue = await createVenue("Batch Cafe");
    const batch = `/api/venue/venues/${venue.id}/templates/batch`;

    const weekdays = [1, 2, 3, 4, 5].map((weekday) => shift(weekday));
    const created = await json<ShiftTemplate[]>(await send("POST", batch, admin.cookie, { templates: weekdays }), 201, "create Mon-Fri");
    expect(created.map((template) => template.weekday)).toEqual([1, 2, 3, 4, 5]);
    expect((await templatesOf(venue.id)).length).toBe(5);

    // The fifth template is invalid, so the first four are not created either.
    const invalid = [1, 2, 3, 4]
      .map((weekday) => shift(weekday, { title: "Evening bar" }))
      .concat(shift(5, { minPeople: 3, maxPeople: 1 }));
    await expectStatus(await send("POST", batch, admin.cookie, { templates: invalid }), 400, "one invalid template");
    const reversed = [shift(6, { title: "Weekend" }), shift(0, { title: "Weekend", startTime: "14:00", endTime: "10:00" })];
    await expectStatus(await send("POST", batch, admin.cookie, { templates: reversed }), 400, "end before start");
    await expectStatus(await send("POST", batch, admin.cookie, { templates: [] }), 400, "no template");
    await expectStatus(await send("POST", batch, staff.cookie, { templates: [shift(6)] }), 403, "staff");
    expect((await templatesOf(venue.id)).map((template) => template.title)).toEqual(Array(5).fill("Morning counter"));
  });

  test("a paused shift plans no slots, stays listed, and comes back when resumed; a deleted one is gone", async () => {
    const venue = await createVenue("Pause Cafe", { timezone: "Europe/Berlin" });
    const tomorrow = dates.formatDateKey(new Date(Date.now() + 86_400_000), { timeZone: "Europe/Berlin" });
    const weekday = new Date(`${tomorrow}T12:00:00Z`).getUTCDay();
    const [counter] = await json<ShiftTemplate[]>(
      await send("POST", `/api/venue/venues/${venue.id}/templates/batch`, admin.cookie, { templates: [shift(weekday)] }),
      201,
      "create shift",
    );
    const slotsFor = async () =>
      (
        await json<VenueDashboard>(await send("GET", `/api/venue/venues/${venue.id}/dashboard`, admin.cookie), 200, "dashboard")
      ).slots.filter((slot) => slot.template.id === counter!.id).length;
    const setActive = (active: boolean, cookie = admin.cookie) =>
      send("PATCH", `/api/venue/venues/${venue.id}/templates/${counter!.id}`, cookie, shift(weekday, { active }));

    expect(await slotsFor()).toBeGreaterThan(0);
    await expectStatus(await setActive(false, staff.cookie), 403, "staff pauses");
    await expectStatus(await setActive(false), 200, "pause");
    expect(await slotsFor()).toBe(0);
    expect((await templatesOf(venue.id)).map((template) => [template.id, template.active])).toEqual([[counter!.id, false]]);
    await expectStatus(
      await send("POST", `/api/venue/venues/${venue.id}/templates/${counter!.id}/signup`, staff.cookie, { date: tomorrow }),
      404,
      "take a paused shift",
    );

    await expectStatus(await setActive(true), 200, "resume");
    expect(await slotsFor()).toBeGreaterThan(0);

    await expectStatus(await send("DELETE", `/api/venue/venues/${venue.id}/templates/${counter!.id}`, admin.cookie), 200, "delete");
    expect(await templatesOf(venue.id)).toEqual([]);
    await expectStatus(await setActive(true), 404, "resume a deleted shift");
  });

  test("a special opening opens the venue during its times, also when only staffing opens it otherwise", async () => {
    // A time zone where it is between 02:00 and 21:59 right now, so a window around now stays on one date.
    const zone = ["UTC", "Etc/GMT-6", "Etc/GMT+6", "Etc/GMT-12"].find((candidate) => {
      const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: candidate }).format(new Date()));
      return hour >= 2 && hour <= 21;
    })!;
    const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: zone }).format(new Date()));
    const today = dates.formatDateKey(new Date(), { timeZone: zone });
    const time = (value: number) => `${String(value).padStart(2, "0")}:00`;
    const venue = await createVenue("Night Cafe", { timezone: zone, openMode: "staffed" });
    const status = async () => json<PublicStatus>(await send("GET", `/api/venue/public/${venue.id}/status`, ""), 200, "public status");

    expect((await status()).open).toBe(false);
    const special = { date: today, kind: "open", startTime: time(hour - 1), endTime: time(hour + 2), note: "Long night" };
    await expectStatus(await send("POST", `/api/venue/venues/${venue.id}/overrides`, staff.cookie, special), 403, "staff adds");
    const created = await json<{ id: string; kind: string }>(
      await send("POST", `/api/venue/venues/${venue.id}/overrides`, admin.cookie, special),
      201,
      "add special opening",
    );
    expect(created.kind).toBe("open");
    expect((await status()).open).toBe(true);

    await expectStatus(
      await send("PATCH", `/api/venue/venues/${venue.id}/overrides/${created.id}`, admin.cookie, {
        ...special,
        startTime: time(hour + 1),
        endTime: time(hour),
      }),
      400,
      "end before start",
    );
    await expectStatus(
      await send("PATCH", `/api/venue/venues/${venue.id}/overrides/${created.id}`, admin.cookie, { date: today, kind: "closed" }),
      200,
      "turn into a closed day",
    );
    expect((await status()).open).toBe(false);
  });

  test("an end time of 24:00 means until midnight for hours, exceptions, and shifts; later times are invalid input", async () => {
    const venue = await createVenue("Midnight Cafe", { timezone: "Europe/Berlin" });
    const base = `/api/venue/venues/${venue.id}`;
    const tomorrow = dates.formatDateKey(new Date(Date.now() + 86_400_000), { timeZone: "Europe/Berlin" });
    const dayAfter = new Date(Date.parse(`${tomorrow}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const weekday = new Date(`${tomorrow}T12:00:00Z`).getUTCDay();
    const midnight = new Date(dates.zonedDateTimeToInstant(`${dayAfter}T00:00`, "Europe/Berlin")).toISOString();

    await expectStatus(
      await send("POST", `${base}/opening-rules`, admin.cookie, { weekday, startTime: "18:00", endTime: "24:00" }),
      201,
      "opening until midnight",
    );
    await expectStatus(
      await send("POST", `${base}/overrides`, admin.cookie, { date: dayAfter, kind: "open", startTime: "20:00", endTime: "24:00" }),
      201,
      "special opening until midnight",
    );
    const [late] = await json<ShiftTemplate[]>(
      await send("POST", `${base}/templates/batch`, admin.cookie, {
        templates: [shift(weekday, { startTime: "18:00", endTime: "24:00" })],
      }),
      201,
      "shift until midnight",
    );
    await expectStatus(await send("GET", `/api/venue/public/${venue.id}/status`, ""), 200, "public status");
    const dashboard = await json<VenueDashboard>(await send("GET", `${base}/dashboard`, admin.cookie), 200, "dashboard");
    expect(dashboard.slots.find((slot) => slot.template.id === late!.id && slot.date === tomorrow)?.endsAt).toBe(midnight);
    await expectStatus(
      await send("POST", `${base}/templates/${late!.id}/signup`, staff.cookie, { date: tomorrow }),
      201,
      "take the shift until midnight",
    );

    await expectStatus(
      await send("POST", `${base}/opening-rules`, admin.cookie, { weekday, startTime: "18:00", endTime: "24:30" }),
      400,
      "past midnight",
    );
  });

  test("admins switch the public page off and on; the unavailable page looks the same as for an unknown venue", async () => {
    const venue = await createVenue("Hidden Cafe");
    const input = { name: venue.name, slug: venue.slug, timezone: venue.timezone };
    const page = (id: string) => send("GET", `/app/venue/public/${id}`, "");

    await expectStatus(
      await send("PATCH", `/api/venue/venues/${venue.id}`, staff.cookie, { ...input, publicEnabled: false }),
      403,
      "staff",
    );
    expect(await expectStatus(await page(venue.id), 200, "public page on")).toContain("Hidden Cafe");

    const off = await json<Venue>(
      await send("PATCH", `/api/venue/venues/${venue.id}`, admin.cookie, { ...input, publicEnabled: false }),
      200,
      "switch off",
    );
    expect(off.publicEnabled).toBe(false);
    await expectStatus(await send("GET", `/api/venue/public/${venue.id}/status`, ""), 404, "status while off");
    for (const [label, id] of [
      ["switched off", venue.id],
      ["unknown", newShortId()],
    ] as const) {
      const html = await expectStatus(await page(id), 404, `${label} page`);
      expect({
        label,
        link: html.includes('href="/app/venue"'),
        text: html.includes("Open in Venues"),
        name: html.includes("Hidden Cafe"),
      }).toEqual({
        label,
        link: true,
        text: true,
        name: false,
      });
    }
    // The overview card follows the switch.
    const listed = await json<{ venues: Venue[] }>(await send("GET", "/api/venue/venues", admin.cookie), 200, "list");
    expect(listed.venues.find((entry) => entry.id === venue.id)?.publicEnabled).toBe(false);

    await expectStatus(
      await send("PATCH", `/api/venue/venues/${venue.id}`, admin.cookie, { ...input, publicEnabled: true }),
      200,
      "switch on",
    );
    await expectStatus(await send("GET", `/api/venue/public/${venue.id}/status`, ""), 200, "status while on");
  });

  test("a slug another venue uses answers 409 on create and on save", async () => {
    const first = await createVenue("Slug Cafe");
    const second = await createVenue("Other Cafe");
    await expectStatus(
      await send("POST", "/api/venue/venues", admin.cookie, { name: "Copy Cafe", slug: first.slug }),
      409,
      "create with a taken slug",
    );
    await expectStatus(
      await send("PATCH", `/api/venue/venues/${second.id}`, admin.cookie, { name: second.name, slug: first.slug }),
      409,
      "save with a taken slug",
    );

    // From a template, a chosen slug is a conflict the same way; without one, the name leads to a free variant.
    await expectStatus(
      await send("POST", "/api/venue/templates/cafe-counter", admin.cookie, { name: "Copy Cafe", slug: first.slug }),
      409,
      "template with a taken slug",
    );
    const derived = await json<Venue>(
      await send("POST", "/api/venue/templates/cafe-counter", admin.cookie, { name: first.slug }),
      201,
      "template without a slug",
    );
    expect(derived.slug).toBe(`${first.slug}-2`);
  });
});
