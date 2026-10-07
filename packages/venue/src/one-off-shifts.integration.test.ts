import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { CapabilityExecutionContext, CloudRuntime, User } from "@k2b/cloud/contracts";
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
import { venueCapabilities } from "./capabilities";
import { ShiftDataSchema, ShiftListDataSchema } from "./capability-contracts";
import { ShiftAssignmentSchema, ShiftTemplateSchema, VenueDashboardSchema, VenueSchema } from "./contracts";
import { newShortId } from "./lib/short-id";
import { venueService } from "./service";

const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(30_000);
const timezone = "Europe/Berlin";
const afterDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const weekday = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();
const shift = { title: "Special event", startTime: "10:00", endTime: "12:00", minPeople: 1, maxPeople: 1, requireTargetForOpening: true };

const venueApp = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .route("/api/venue", apiRoutes);

const send = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, cookie: string, body?: unknown) =>
  venueApp.request(path, {
    method,
    headers: { cookie, "x-forwarded-for": uniqueCallerAddress(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (response: Response, status: number): Promise<unknown> => {
  const body = await response.text();
  expect({ status: response.status, body: response.status === status ? "" : body }).toEqual({ status, body: "" });
  return JSON.parse(body);
};

const insertPerson = async (label: string) => {
  const uid = `venue-one-off-${label}-${crypto.randomUUID()}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${uid}, 'local', 'user', ${label}, ${`${uid}@example.test`}) RETURNING id
  `;
  if (!row) throw new Error("Missing test user");
  const user: User = {
    id: row.id,
    uid,
    roles: ["user", "local", "local/user"],
    provider: "local",
    profile: "user",
    givenname: "Venue",
    sn: label,
    displayName: label,
    mail: `${uid}@example.test`,
    avatarHash: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
    ipa: null,
  };
  return { user, cookie: `session_token=${await createTestSession(user.id)}` };
};
const contextFor = (user: User): CapabilityExecutionContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  user,
  locale: "en",
  requestId: crypto.randomUUID(),
  origin: "app",
  signal: new AbortController().signal,
});

suite("Venue one-off shifts", () => {
  let admin: Awaited<ReturnType<typeof insertPerson>>;
  let staff: Awaited<ReturnType<typeof insertPerson>>;
  const venueIds: string[] = [];
  let today: string;
  let tomorrow: string;

  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
    admin = await insertPerson("admin");
    staff = await insertPerson("staff");
    today = dates.formatDateKey(new Date(), { timeZone: timezone });
    tomorrow = afterDays(today, 1);
  });
  afterAll(async () => {
    for (const id of venueIds) await sql`DELETE FROM venue.venues WHERE short_id = ${id}`;
    for (const person of [admin, staff]) if (person) await sql`DELETE FROM auth.users WHERE id = ${person.user.id}::uuid`;
  });

  const createVenue = async (venueTimezone = timezone) => {
    const venue = VenueSchema.parse(
      await json(
        await send("POST", "/api/venue/venues", admin.cookie, {
          name: "One-off venue",
          slug: `one-off-${crypto.randomUUID()}`,
          timezone: venueTimezone,
          openMode: "staffed",
        }),
        201,
      ),
    );
    venueIds.push(venue.id);
    await json(
      await send("POST", `/api/venue/venues/${venue.id}/access`, admin.cookie, {
        principal: { type: "user", userId: staff.user.id },
        permission: "write",
      }),
      201,
    );
    return venue;
  };
  const createShift = async (id: string, body: unknown) =>
    ShiftTemplateSchema.parse(await json(await send("POST", `/api/venue/venues/${id}/templates`, admin.cookie, body), 201));
  const dashboard = async (id: string, date: string, days = 14) =>
    VenueDashboardSchema.parse(
      await json(await send("GET", `/api/venue/venues/${id}/dashboard?slotStartDate=${date}&slotDays=${days}`, staff.cookie), 200),
    );

  test("plans one date, preserves weekly shifts, and shares signup, capacity, cancellation and public status", async () => {
    const venue = await createVenue();
    const oneOff = await createShift(venue.id, { ...shift, date: tomorrow });
    const weekly = await createShift(venue.id, { ...shift, weekday: weekday(tomorrow), title: "Weekly" });
    expect({ date: oneOff.date, weekday: oneOff.weekday, weeklyDate: weekly.date }).toEqual({
      date: tomorrow,
      weekday: weekday(tomorrow),
      weeklyDate: null,
    });
    const planned = await dashboard(venue.id, tomorrow);
    expect(planned.slots.filter((slot) => slot.template.id === oneOff.id).map((slot) => slot.date)).toEqual([tomorrow]);
    expect(planned.slots.filter((slot) => slot.template.id === weekly.id).map((slot) => slot.date)).toEqual([
      tomorrow,
      afterDays(tomorrow, 7),
    ]);
    expect(planned.overrides).toEqual([]);
    expect(planned.outlook.missingPeople).toBe(2);
    const signup = `/api/venue/venues/${venue.id}/templates/${oneOff.id}/signup`;
    const wrong = await send("POST", signup, staff.cookie, { date: afterDays(tomorrow, 7) });
    const wrongBody = await wrong.text();
    expect(wrong.status).toBe(400);
    expect(wrongBody).toContain("The selected date does not match this shift's weekday");
    const assignment = ShiftAssignmentSchema.parse(await json(await send("POST", signup, staff.cookie, { date: tomorrow }), 201));
    expect(assignment.templateId).toBe(oneOff.id);
    const calendar = await venueService.ical.generateUser(staff.user.id, "https://cloud.example.test", "en");
    expect(calendar).toContain(`UID:venue-${assignment.id}@stuve.cloud`);
    expect(calendar).toContain("DESCRIPTION:Special event");
    const booked = (await dashboard(venue.id, tomorrow)).slots.find((slot) => slot.template.id === oneOff.id);
    expect(booked?.full).toBeTrue();
    expect(booked?.assignments.map((entry) => entry.id)).toEqual([assignment.id]);
    expect((await send("POST", signup, staff.cookie, { date: tomorrow })).status).toBe(400);
    expect((await send("POST", signup, admin.cookie, { date: tomorrow })).status).toBe(400);
    const at = (date: string) => new Date(dates.zonedDateTimeToInstant(`${date}T10:30`, timezone));
    expect((await venueService.publicStatus(venue.id, at(tomorrow)))?.open).toBeTrue();
    expect((await venueService.publicStatus(venue.id, at(afterDays(tomorrow, 7))))?.open).toBeFalse();
    expect((await send("DELETE", `/api/venue/venues/${venue.id}/assignments/${assignment.id}`, staff.cookie)).status).toBe(200);
    expect((await dashboard(venue.id, tomorrow)).slots.find((slot) => slot.template.id === oneOff.id)?.assignedCount).toBe(0);
    expect((await venueService.publicStatus(venue.id, at(tomorrow)))?.open).toBeFalse();
    const multiple = await send("POST", `/api/venue/venues/${venue.id}/templates/${oneOff.id}/signup-weeks`, staff.cookie, {
      date: tomorrow,
      weeks: 4,
    });
    expect(ShiftAssignmentSchema.array().parse(await json(multiple, 201))).toHaveLength(1);
  });

  test("capability list/read/review/signup use short IDs and the same dated occurrence", async () => {
    const venue = await createVenue();
    const template = await createShift(venue.id, { ...shift, date: tomorrow });
    const weekly = await createShift(venue.id, { ...shift, title: "Weekly", weekday: weekday(tomorrow) });
    const context = contextFor(staff.user);
    const list = venueCapabilities.queries["shift.list"];
    const result = await list.run(list.input.parse({ venueId: venue.id, startDate: tomorrow, days: 14 }), context);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    const shifts = ShiftListDataSchema.parse(result.data.data);
    expect(shifts.filter((entry) => entry.templateId === template.id).map((entry) => [entry.date, entry.recurring])).toEqual([
      [tomorrow, false],
    ]);
    expect(shifts.filter((entry) => entry.templateId === weekly.id).map((entry) => entry.recurring)).toEqual([true, true]);
    const selected = shifts.find((entry) => entry.templateId === template.id);
    if (!selected) throw new Error("Missing one-off shift");
    const input = { venueId: selected.venueId, templateId: selected.templateId, date: selected.date };
    const read = venueCapabilities.queries["shift.read"];
    const detail = await read.run(read.input.parse(input), context);
    expect(detail.ok).toBeTrue();
    if (!detail.ok) throw new Error(detail.error.message);
    expect(ShiftDataSchema.parse(detail.data.data)).toEqual(selected);
    expect((await read.run(read.input.parse({ ...input, date: afterDays(tomorrow, 7) }), context)).ok).toBeFalse();
    const signup = venueCapabilities.actions["assignment.signup"];
    expect((await signup.review(signup.input.parse(input), context)).ok).toBeTrue();
    const taken = await signup.run(signup.input.parse(input), context);
    expect(taken.ok).toBeTrue();
    const booked = await dashboard(venue.id, tomorrow);
    expect(booked.slots.find((slot) => slot.template.id === template.id)?.assignedCount).toBe(1);
    expect((await signup.review(signup.input.parse(input), context)).ok).toBeFalse();
    expect((await signup.run(signup.input.parse({ ...input, date: afterDays(tomorrow, 7) }), context)).ok).toBeFalse();
  });

  test("rejects past dates, dates beyond the horizon, and kind switches; derives weekdays when moving a one-off", async () => {
    const venue = await createVenue();
    const base = `/api/venue/venues/${venue.id}/templates`;
    for (const date of [afterDays(today, -1), afterDays(today, 367)]) {
      expect((await send("POST", base, admin.cookie, { ...shift, date })).status).toBe(400);
    }
    expect((await createShift(venue.id, { ...shift, date: today })).date).toBe(today);
    expect((await createShift(venue.id, { ...shift, date: afterDays(today, 366) })).date).toBe(afterDays(today, 366));
    const template = await createShift(venue.id, { ...shift, date: tomorrow });
    const weekly = await createShift(venue.id, { ...shift, weekday: weekday(tomorrow) });
    expect((await send("PATCH", `${base}/${template.id}`, admin.cookie, { ...shift, date: null, weekday: template.weekday })).status).toBe(
      400,
    );
    expect((await send("PATCH", `${base}/${weekly.id}`, admin.cookie, { ...shift, date: tomorrow })).status).toBe(400);
    for (const date of [afterDays(today, -1), afterDays(today, 367)]) {
      expect((await send("PATCH", `${base}/${template.id}`, admin.cookie, { ...shift, date })).status).toBe(400);
    }
    const movedDate = afterDays(tomorrow, 1);
    const moved = ShiftTemplateSchema.parse(
      await json(await send("PATCH", `${base}/${template.id}`, admin.cookie, { ...shift, date: movedDate }), 200),
    );
    expect([moved.date, moved.weekday]).toEqual([movedDate, weekday(movedDate)]);
    expect((await dashboard(venue.id, tomorrow, 1)).slots.some((slot) => slot.template.id === template.id)).toBeFalse();
    expect((await dashboard(venue.id, movedDate, 1)).slots.some((slot) => slot.template.id === template.id)).toBeTrue();
    const before = (await dashboard(venue.id, tomorrow)).templates.length;
    expect(
      (
        await send("POST", `${base}/batch`, admin.cookie, {
          templates: [
            { ...shift, date: tomorrow },
            { ...shift, date: afterDays(today, -1) },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await dashboard(venue.id, tomorrow)).templates).toHaveLength(before);
  });

  test("uses the venue-local day rather than the server day for creation and the admin window", async () => {
    const utcDay = dates.formatDateKey(new Date(), { timeZone: "UTC" });
    const east = "Pacific/Kiritimati";
    const venueTimezone = dates.formatDateKey(new Date(), { timeZone: east }) !== utcDay ? east : "Etc/GMT+12";
    const localToday = dates.formatDateKey(new Date(), { timeZone: venueTimezone });
    expect(localToday).not.toBe(utcDay);
    const venue = await createVenue(venueTimezone);
    const base = `/api/venue/venues/${venue.id}/templates`;
    expect((await createShift(venue.id, { ...shift, date: localToday })).date).toBe(localToday);
    expect((await send("POST", base, admin.cookie, { ...shift, date: afterDays(localToday, -1) })).status).toBe(400);
    expect((await createShift(venue.id, { ...shift, date: afterDays(localToday, 366) })).date).toBe(afterDays(localToday, 366));
    expect((await send("POST", base, admin.cookie, { ...shift, date: afterDays(localToday, 367) })).status).toBe(400);
    const internalId = await venueService.publicResources.resolve("venues", venue.id);
    if (!internalId) throw new Error("Missing internal venue ID");
    for (const offset of [-7, -8, 367]) {
      const date = afterDays(localToday, offset);
      await sql`INSERT INTO venue.shift_templates(short_id,venue_id,weekday,date,title,start_time,end_time)
        VALUES (${newShortId()},${internalId}::uuid,${weekday(date)},${date}::date,'Window boundary','10:00','12:00')`;
    }
    const window = await dashboard(venue.id, localToday, 1);
    expect(window.templates.map((entry) => entry.date).sort()).toEqual(
      [afterDays(localToday, -7), localToday, afterDays(localToday, 366)].sort(),
    );
  });

  test("old one-offs stay in historical calendars without filling the admin window or capability cap", async () => {
    const venue = await createVenue();
    const oneOff = await createShift(venue.id, { ...shift, date: tomorrow });
    const internalId = await venueService.publicResources.resolve("venues", venue.id);
    if (!internalId) throw new Error("Missing internal venue ID");
    const oldDate = afterDays(today, -30);
    const oldTemplateId = newShortId();
    const historicalDate = afterDays(today, -40);
    const oldAssignmentsDate = afterDays(today, -7);
    // Persist history directly: creation through the public API correctly rejects past dates.
    await sql.begin(async (tx) => {
      for (let i = 0; i < 103; i++) {
        const date = i === 1 ? oldAssignmentsDate : i === 2 ? historicalDate : oldDate;
        await tx`INSERT INTO venue.shift_templates(short_id,venue_id,weekday,date,title,start_time,end_time)
          VALUES (${i === 0 ? oldTemplateId : newShortId()},${internalId}::uuid,${weekday(date)},${date}::date,'Past event','10:00','12:00')`;
      }
    });
    const adminWindow = await dashboard(venue.id, oldDate, 1);
    expect(adminWindow.templates.map((entry) => entry.date).sort()).toEqual([oldAssignmentsDate, tomorrow].sort());
    expect(adminWindow.slots).toHaveLength(101);
    expect(adminWindow.slots.find((entry) => entry.template.id === oldTemplateId)?.template.date).toBe(oldDate);
    expect((await dashboard(venue.id, afterDays(oldDate, 7), 1)).slots).toEqual([]);
    const list = venueCapabilities.queries["shift.list"];
    const context = contextFor(staff.user);
    const upcoming = await list.run(list.input.parse({ venueId: venue.id, startDate: tomorrow, days: 1 }), context);
    expect(upcoming.ok).toBeTrue();
    const past = await list.run(list.input.parse({ venueId: venue.id, startDate: historicalDate, days: 1 }), context);
    expect(past.ok).toBeTrue();
    if (!past.ok) throw new Error(past.error.message);
    expect(ShiftListDataSchema.parse(past.data.data).map((entry) => [entry.date, entry.recurring])).toEqual([[historicalDate, false]]);
    // The cap still rejects ranges that really contain more than 100 active shifts.
    expect((await list.run(list.input.parse({ venueId: venue.id, startDate: oldDate, days: 1 }), context)).ok).toBeFalse();
    const read = venueCapabilities.queries["shift.read"];
    const historical = await read.run(read.input.parse({ venueId: venue.id, templateId: oldTemplateId, date: oldDate }), context);
    expect(historical.ok).toBeTrue();
    const signup = venueCapabilities.actions["assignment.signup"];
    const input = signup.input.parse({ venueId: venue.id, templateId: oneOff.id, date: tomorrow });
    expect((await signup.review(input, context)).ok).toBeTrue();
    expect((await signup.run(input, context)).ok).toBeTrue();
    const pastEdit = await send("PATCH", `/api/venue/venues/${venue.id}/templates/${oldTemplateId}`, admin.cookie, {
      ...shift,
      date: oldDate,
      title: "Updated old event",
    });
    expect(ShiftTemplateSchema.parse(await json(pastEdit, 200)).date).toBe(oldDate);
    expect(
      (
        await send("PATCH", `/api/venue/venues/${venue.id}/templates/${oldTemplateId}`, admin.cookie, {
          ...shift,
          date: afterDays(oldDate, 1),
        })
      ).status,
    ).toBe(400);
  });
});
