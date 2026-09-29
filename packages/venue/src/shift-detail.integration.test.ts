import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { settings } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { dates } from "@k2b/stdlib";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import apiRoutes from "./api";
import type { ShiftAssignment, ShiftTemplate, VenueDashboard } from "./contracts";
import "./frontend/ssr-test-plugin";

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

const send = (method: "GET" | "POST" | "DELETE", path: string, cookie: string, body?: unknown) =>
  venueApp.request(path, {
    method,
    headers: {
      cookie,
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

const shiftDate = (date: string, days: number): string =>
  new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + days, 12))
    .toISOString()
    .slice(0, 10);
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

type Person = { id: string; name: string; cookie: string };
const people: Person[] = [];
const insertPerson = async (label: string): Promise<Person> => {
  const suffix = crypto.randomUUID();
  const name = `Venue ${label} ${suffix.slice(0, 4)}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`venue-detail-${label}-${suffix}`}, 'local', 'user', ${name}, ${`venue-detail-${label}-${suffix}@example.test`})
    RETURNING id
  `;
  const person = { id: row!.id, name, cookie: `session_token=${await createTestSession(row!.id)}` };
  people.push(person);
  return person;
};

suite("Venue shift detail", () => {
  let admin: Person;
  let staff: Person;
  let colleague: Person;
  let reader: Person;
  let venueId: string;
  let counter: ShiftTemplate;
  const today = dates.formatDateKey(new Date(), { timeZone: "Europe/Berlin" });
  const tomorrow = shiftDate(today, 1);
  const dayAfter = shiftDate(today, 2);

  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
    admin = await insertPerson("admin");
    staff = await insertPerson("staff");
    colleague = await insertPerson("colleague");
    reader = await insertPerson("reader");
    const created = await send("POST", "/api/venue/venues", admin.cookie, {
      name: "Harbor Cafe",
      slug: `harbor-detail-${admin.id.slice(0, 8)}`,
      timezone: "Europe/Berlin",
    });
    venueId = (await json<{ id: string }>(created, 201, "create venue")).id;
    for (const [person, permission] of [
      [staff, "write"],
      [colleague, "write"],
      [reader, "read"],
    ] as const) {
      const grant = await send("POST", `/api/venue/venues/${venueId}/access`, admin.cookie, {
        principal: { type: "user", userId: person.id },
        permission,
      });
      await json(grant, 201, `grant ${permission}`);
    }
    const template = async (title: string, date: string, startTime: string, minPeople: number) =>
      json<ShiftTemplate>(
        await send("POST", `/api/venue/venues/${venueId}/templates`, admin.cookie, {
          weekday: weekday(date),
          title,
          startTime,
          endTime: "14:00",
          minPeople,
          maxPeople: 3,
        }),
        201,
        `create ${title}`,
      );
    // One shift tomorrow and one the day after: each occurs once in the seven days from today.
    counter = await template("Lunch counter", tomorrow, "11:00", 2);
    await template("Coffee bar", dayAfter, "09:00", 1);
  });

  afterAll(async () => {
    await sql`
      DELETE FROM venue.venues WHERE id IN (
        SELECT va.venue_id FROM venue.venue_access va JOIN auth.access a ON a.id = va.access_id WHERE a.user_id = ${admin.id}::uuid
      )
    `;
    for (const person of people) await sql`DELETE FROM auth.users WHERE id = ${person.id}::uuid`;
  });

  const dashboard = async (person: Person, query = "") =>
    json<VenueDashboard>(await send("GET", `/api/venue/venues/${venueId}/dashboard${query}`, person.cookie), 200, `dashboard ${query}`);
  const take = async (person: Person, template: ShiftTemplate, date: string) =>
    json<ShiftAssignment>(
      await send("POST", `/api/venue/venues/${venueId}/templates/${template.id}/signup`, person.cookie, { date }),
      201,
      `${person.name} takes ${template.title}`,
    );
  const remove = (person: Person, assignment: ShiftAssignment) =>
    send("DELETE", `/api/venue/venues/${venueId}/assignments/${assignment.id}`, person.cookie);
  const expectRemoved = async (person: Person, assignment: ShiftAssignment, label: string) =>
    expect({ label, status: (await remove(person, assignment)).status }).toEqual({ label, status: 200 });

  test("only admins remove another person from a shift; staff and readers leave only their own", async () => {
    const taken = await take(staff, counter, tomorrow);

    // The server rejects the same request the detail offers only to admins.
    for (const person of [colleague, reader]) {
      const response = await remove(person, taken);
      expect({ person: person.name, status: response.status }).toEqual({ person: person.name, status: 404 });
    }
    const stillThere = await dashboard(staff, `?slotStartDate=${tomorrow}&slotDays=1`);
    expect(stillThere.slots.find((slot) => slot.template.id === counter.id)?.assignments.map((entry) => entry.id)).toEqual([taken.id]);

    await expectRemoved(admin, taken, "admin removes the staff member");
    const after = await dashboard(admin, `?slotStartDate=${tomorrow}&slotDays=1`);
    expect(after.slots.find((slot) => slot.template.id === counter.id)?.assignments).toEqual([]);

    const own = await take(staff, counter, tomorrow);
    await expectRemoved(staff, own, "staff leaves their own shift");
  });

  test("free time sits in the calendar window as its own entry", async () => {
    const free = await json<ShiftAssignment>(
      await send("POST", `/api/venue/venues/${venueId}/free-signup`, staff.cookie, {
        startsAt: new Date(`${tomorrow}T13:00:00Z`).toISOString(),
        endsAt: new Date(`${tomorrow}T14:00:00Z`).toISOString(),
        note: "Inventory count",
      }),
      201,
      "free time",
    );
    const inWindow = await dashboard(reader, `?slotStartDate=${tomorrow}&slotDays=1`);
    expect(inWindow.otherAssignments.map((entry) => [entry.id, entry.userDisplayName, entry.note])).toEqual([
      [free.id, staff.name, "Inventory count"],
    ]);
    expect(inWindow.slots.flatMap((slot) => slot.assignments).some((entry) => entry.id === free.id)).toBe(false);
    expect((await dashboard(reader, `?slotStartDate=${shiftDate(today, 9)}&slotDays=7`)).otherAssignments).toEqual([]);
    await expectRemoved(staff, free, "leave free time");
  });

  test("the key figures cover today and the next six days, whatever window the calendar shows", async () => {
    const taken = await take(staff, counter, tomorrow);
    try {
      const outlooks = await Promise.all(
        [
          "",
          `?slotStartDate=${tomorrow}&slotDays=1`,
          `?slotStartDate=${shiftDate(today, -30)}&slotDays=42`,
          `?slotStartDate=${shiftDate(today, 60)}&slotDays=7`,
        ].map(async (query) => (await dashboard(reader, query)).outlook),
      );
      expect(outlooks[0]).toEqual({
        startDate: today,
        endDate: shiftDate(today, 6),
        // The counter misses one of two people, the bar its only one.
        missingPeople: 2,
        nextGap: {
          templateId: counter.id,
          date: tomorrow,
          title: "Lunch counter",
          startsAt: expect.any(String),
          endsAt: expect.any(String),
          missingPeople: 1,
        },
      });
      for (const outlook of outlooks) expect(outlook).toEqual(outlooks[0]!);
    } finally {
      await remove(staff, taken);
    }
  });

  test("the schedule page renders the selected shift and remembers the calendar view per browser", async () => {
    const taken = await take(staff, counter, tomorrow);
    try {
      const page = async (person: Person, query: string, cookie = "") => {
        const response = await send("GET", `/app/venue/${venueId}/shifts${query}`, `${person.cookie}${cookie}`);
        return { status: response.status, text: await response.text() };
      };
      const selected = `?cv=week&cd=${tomorrow}&shift=${counter.id}:${tomorrow}`;

      const asAdmin = await page(admin, selected);
      expect(asAdmin.status).toBe(200);
      expect(asAdmin.text).toContain("k2b-app-workspace__detail max-lg:hidden!");
      expect(asAdmin.text).toContain(`aria-label="Remove ${staff.name}"`);

      const asColleague = await page(colleague, selected);
      expect(asColleague.text).toContain(staff.name);
      expect(asColleague.text).not.toContain(`aria-label="Remove ${staff.name}"`);

      // Without `cv`, the view this browser used last; an unknown view falls back to the week.
      const remembered = await page(reader, `?cd=${tomorrow}`, "; venue_calendar_view=mobile-month");
      expect(remembered.text).toContain("k2b-calendar-mobile-month");
      const unknown = await page(reader, `?cd=${tomorrow}`, "; venue_calendar_view=year");
      expect(unknown.text).not.toContain("k2b-calendar-mobile-month");
      expect((await page(reader, `?cv=day&cd=${tomorrow}`)).text).toContain("Lunch counter");
    } finally {
      await remove(staff, taken);
    }
  });
});
