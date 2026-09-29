import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { lazySync } from "@k2b/cloud";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { notifications, settings } from "@k2b/cloud/services";
import { registerNotificationDefinitions } from "@k2b/cloud/services/notifications/catalog";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { dates } from "@k2b/stdlib";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import type { AccessEntry } from "@k2b/cloud/contracts";
import apiRoutes from "./api";
import { app } from "./config";
import type { ShiftAssignment, ShiftTemplate } from "./contracts";
import { newShortId } from "./lib/short-id";
import { NOTIFICATIONS } from "./notifications";
import { noticeKeys, notifyShiftCancelled, runShiftNotices, shiftNoticeScheduler } from "./shift-notices";

const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(60_000);

const venueApp = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .route("/api/venue", apiRoutes);

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

const json = async <T>(response: Response, status: number, label: string): Promise<T> => {
  const text = await response.text();
  expect({ label, status: response.status, body: response.status === status ? "" : text.slice(0, 2_000) }).toEqual({
    label,
    status,
    body: "",
  });
  return JSON.parse(text) as T;
};

const TZ = "Europe/Berlin";
const clock = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** The venue day, weekday, and clock times of a one-hour shift starting at `instant`, ending by midnight. */
const slotAt = (instant: Date) => {
  const date = dates.formatDateKey(instant, { timeZone: TZ });
  const startTime = clock.format(instant);
  const hour = Number(startTime.slice(0, 2)) + 1;
  return {
    date,
    weekday: new Date(`${date}T12:00:00Z`).getUTCDay(),
    startTime,
    endTime: hour >= 24 ? "24:00" : `${String(hour).padStart(2, "0")}${startTime.slice(2)}`,
  };
};
const quarterHour = 15 * 60_000;
const inHours = (hours: number) => new Date(Math.floor((Date.now() + hours * 3_600_000) / quarterHour) * quarterHour);

type Person = { id: string; name: string; cookie: string };
const people: Person[] = [];
const insertPerson = async (label: string): Promise<Person> => {
  const suffix = crypto.randomUUID();
  const name = `Notice ${label} ${suffix.slice(0, 4)}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`venue-notice-${label}-${suffix}`}, 'local', 'user', ${name}, ${`venue-notice-${label}-${suffix}@example.test`})
    RETURNING id
  `;
  const person = { id: row!.id, name, cookie: `session_token=${await createTestSession(row!.id)}` };
  people.push(person);
  return person;
};

type EventRow = { title: string; target_href: string | null; idempotency_key: string; id: string };
const eventsFor = (definitionId: string, person: Person) =>
  sql<EventRow[]>`
    SELECT id, title, target_href, idempotency_key
    FROM notifications.events
    WHERE definition_id = ${definitionId} AND recipient_user_id = ${person.id}::uuid
    ORDER BY created_at, id
  `;

suite("Venue shift notices", () => {
  let admin: Person;
  let groupAdmin: Person;
  let staff: Person;
  let colleague: Person;
  let leaver: Person;
  const groupId = crypto.randomUUID();
  let venueId: string;
  let closedVenueId: string;
  let soon: ShiftTemplate;
  let later: ShiftTemplate;
  let laterAssignment: ShiftAssignment;
  let colleagueSoon: ShiftAssignment;
  const soonSlot = slotAt(inHours(3));
  const laterSlot = slotAt(inHours(30));

  const createVenue = async (name: string, slug: string) =>
    (await json<{ id: string }>(await send("POST", "/api/venue/venues", admin.cookie, { name, slug, timezone: TZ }), 201, `create ${name}`))
      .id;
  const grant = async (venue: string, principal: unknown, permission: string) =>
    json<AccessEntry>(
      await send("POST", `/api/venue/venues/${venue}/access`, admin.cookie, { principal, permission }),
      201,
      `grant ${permission}`,
    );
  const template = async (venue: string, title: string, slot: ReturnType<typeof slotAt>, extra: Record<string, unknown> = {}) =>
    json<ShiftTemplate>(
      await send("POST", `/api/venue/venues/${venue}/templates`, admin.cookie, {
        weekday: slot.weekday,
        title,
        startTime: slot.startTime,
        endTime: slot.endTime,
        ...extra,
      }),
      201,
      `create ${title}`,
    );
  const take = async (venue: string, person: Person, shift: ShiftTemplate, date: string) =>
    json<ShiftAssignment>(
      await send("POST", `/api/venue/venues/${venue}/templates/${shift.id}/signup`, person.cookie, { date }),
      201,
      `${person.name} takes ${shift.title}`,
    );
  /** Sign-ups made days ago, so their reminder is due now. */
  const backdate = (venue: string) => sql`
    UPDATE venue.shift_assignments SET created_at = now() - INTERVAL '3 days'
    WHERE venue_id = (SELECT id FROM venue.venues WHERE short_id = ${venue})
  `;
  const internalId = async (table: "shift_templates" | "shift_assignments", shortId: string) =>
    (await sql.unsafe(`SELECT id FROM venue.${table} WHERE short_id = $1`, [shortId]))[0]!.id as string;

  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
    await registerNotificationDefinitions(app.meta.id, app.notifications);
    admin = await insertPerson("admin");
    groupAdmin = await insertPerson("group-admin");
    staff = await insertPerson("staff");
    colleague = await insertPerson("colleague");
    leaver = await insertPerson("leaver");
    await sql`INSERT INTO auth.groups (id, cn, provider, name) VALUES (${groupId}::uuid, ${`venue-notice-${groupId}`}, 'local', 'Venue coordinators')`;
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${groupAdmin.id}::uuid, ${groupId}::uuid)`;

    venueId = await createVenue("Harbor Cafe", `harbor-notice-${admin.id.slice(0, 8)}`);
    await grant(venueId, { type: "group", groupId }, "admin");
    for (const person of [staff, colleague]) await grant(venueId, { type: "user", userId: person.id }, "write");
    const leaverAccess = await grant(venueId, { type: "user", userId: leaver.id }, "write");

    soon = await template(venueId, "Evening bar", soonSlot, { minPeople: 4, maxPeople: 5 });
    later = await template(venueId, "Morning counter", laterSlot, { minPeople: 2 });
    await template(venueId, "Paused shift", soonSlot, { minPeople: 2, active: false });
    await take(venueId, staff, soon, soonSlot.date);
    colleagueSoon = await take(venueId, colleague, soon, soonSlot.date);
    await take(venueId, leaver, soon, soonSlot.date);
    laterAssignment = await take(venueId, staff, later, laterSlot.date);
    await backdate(venueId);
    // The leaver keeps the sign-up but no longer works here.
    await json(
      await send("PATCH", `/api/venue/venues/${venueId}/access/${leaverAccess.id}`, admin.cookie, { permission: "read" }),
      200,
      "downgrade",
    );

    // A second venue is closed on the day of its understaffed shift.
    closedVenueId = await createVenue("Garden Kiosk", `garden-notice-${admin.id.slice(0, 8)}`);
    await grant(closedVenueId, { type: "user", userId: staff.id }, "write");
    const kiosk = await template(closedVenueId, "Kiosk", soonSlot, { minPeople: 3 });
    await take(closedVenueId, staff, kiosk, soonSlot.date);
    await backdate(closedVenueId);
    await json(
      await send("POST", `/api/venue/venues/${closedVenueId}/overrides`, admin.cookie, {
        date: soonSlot.date,
        kind: "closed",
        note: "Holiday",
      }),
      201,
      "close the day",
    );
  });

  afterAll(async () => {
    await shiftNoticeScheduler.stop();
    await sql`
      DELETE FROM venue.venues WHERE id IN (
        SELECT va.venue_id FROM venue.venue_access va JOIN auth.access a ON a.id = va.access_id WHERE a.user_id = ${admin.id}::uuid
      )
    `;
    for (const person of people) await sql`DELETE FROM auth.users WHERE id = ${person.id}::uuid`;
    await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
  });

  test("the three notices appear in notification preferences in English and German and can be turned off", async () => {
    const english = await notifications.user.preferences.list(staff.id, "en");
    const german = await notifications.user.preferences.list(staff.id, "de");
    const venueLabels = (list: typeof english) =>
      list.definitions
        .filter((definition) => definition.appId === "venue")
        .map((definition) => [definition.id, definition.label, definition.recommendedChannels]);
    expect(venueLabels(english)).toEqual([
      ["venue.shiftCancelled", "Shift cancellations", ["browser", "email"]],
      ["venue.shiftReminder", "Shift reminders", ["browser", "email"]],
      ["venue.shiftUnderstaffed", "Understaffed shifts", ["browser", "email"]],
    ]);
    expect(venueLabels(german).map(([, label]) => label)).toEqual(["Schicht-Absagen", "Schicht-Erinnerungen", "Unterbesetzte Schichten"]);

    // The staff member turns reminders off on every channel; the reminder event is still recorded, but not delivered.
    const off = await notifications.user.preferences.set({
      userId: staff.id,
      definitionId: app.notifications.shiftReminder.id,
      channels: [],
    });
    expect(off.ok).toBe(true);
  });

  test("a scan reminds each person with access once, reports the gap to every admin once, and repeats nothing", async () => {
    const first = await runShiftNotices({ now: new Date() });
    expect(first.failed).toBe(0);

    const reminders = await eventsFor(app.notifications.shiftReminder.id, colleague);
    expect(reminders).toEqual([
      {
        id: expect.any(String),
        title: expect.stringMatching(/^Your shift .+ · Harbor Cafe$/),
        target_href: `/app/venue/${venueId}/shifts?cd=${soonSlot.date}&shift=a:${colleagueSoon.id}`,
        idempotency_key: noticeKeys.reminder(
          await internalId("shift_assignments", colleagueSoon.id),
          new Date(colleagueSoon.startsAt).toISOString(),
        ),
      },
    ]);
    // Staff turned reminders off: one event, no delivery. The shift in 30 hours and the closed day send nothing.
    const staffReminders = await eventsFor(app.notifications.shiftReminder.id, staff);
    expect(staffReminders).toHaveLength(1);
    expect(staffReminders[0]!.target_href).toStartWith(`/app/venue/${venueId}/`);
    const deliveries = await sql<{ status: string; error_code: string | null }[]>`
      SELECT status, error_code FROM notifications.deliveries WHERE event_id = ${staffReminders[0]!.id}::uuid
    `;
    expect(deliveries).toEqual([{ status: "suppressed", error_code: "disabled_by_user" }]);
    // Lost staff access: no reminder.
    expect(await eventsFor(app.notifications.shiftReminder.id, leaver)).toEqual([]);

    const soonId = await internalId("shift_templates", soon.id);
    for (const person of [admin, groupAdmin]) {
      const gaps = await eventsFor(app.notifications.shiftUnderstaffed.id, person);
      expect(gaps.map((event) => [event.title.startsWith("1 missing · "), event.target_href, event.idempotency_key])).toEqual([
        [
          true,
          `/app/venue/${venueId}/shifts?cd=${soonSlot.date}&shift=${soon.id}:${soonSlot.date}`,
          noticeKeys.understaffed(soonId, soonSlot.date, person.id),
        ],
      ]);
    }
    for (const person of [staff, colleague, leaver]) expect(await eventsFor(app.notifications.shiftUnderstaffed.id, person)).toEqual([]);

    // A repeated scan, and one in a later slot, find every notice sent already.
    await runShiftNotices({ now: new Date() });
    await runShiftNotices({ now: new Date(Date.now() + 15 * 60_000), batchSize: 1 });
    expect(await eventsFor(app.notifications.shiftReminder.id, colleague)).toHaveLength(1);
    expect(await eventsFor(app.notifications.shiftReminder.id, staff)).toHaveLength(1);
    for (const person of [admin, groupAdmin]) expect(await eventsFor(app.notifications.shiftUnderstaffed.id, person)).toHaveLength(1);
  });

  test("a scan stops when it is canceled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runShiftNotices({ now: new Date(), signal: controller.signal })).rejects.toThrow();
  });

  test("leaving an upcoming shift tells every admin once, also when the request or the notice repeats", async () => {
    const assignmentId = await internalId("shift_assignments", laterAssignment.id);
    expect((await send("DELETE", `/api/venue/venues/${venueId}/assignments/${laterAssignment.id}`, staff.cookie)).status).toBe(200);
    // The retried request finds nothing to cancel.
    expect((await send("DELETE", `/api/venue/venues/${venueId}/assignments/${laterAssignment.id}`, staff.cookie)).status).toBe(404);

    for (const person of [admin, groupAdmin]) {
      const events = await eventsFor(app.notifications.shiftCancelled.id, person);
      expect(events).toHaveLength(1);
      expect(events[0]!.title).toMatch(new RegExp(`^${staff.name} left .+ · Harbor Cafe$`));
      expect(events[0]!.target_href).toBe(`/app/venue/${venueId}/shifts?cd=${laterSlot.date}&shift=${later.id}:${laterSlot.date}`);
      expect(events[0]!.idempotency_key).toBe(noticeKeys.cancelled(assignmentId));
    }
    expect(await eventsFor(app.notifications.shiftCancelled.id, staff)).toEqual([]);

    // Sending the same cancellation again reuses each admin's event.
    await notifyShiftCancelled({
      venue: {
        id: (await sql<{ id: string }[]>`SELECT id FROM venue.venues WHERE short_id = ${venueId}`)[0]!.id,
        name: "Harbor Cafe",
        timezone: TZ,
      },
      cancelled: {
        id: assignmentId,
        userId: staff.id,
        userDisplayName: staff.name,
        templateId: later.id,
        templateTitle: later.title,
        startsAt: laterAssignment.startsAt,
        endsAt: laterAssignment.endsAt,
      },
      actor: { id: staff.id, uid: staff.id, displayName: staff.name },
    });
    for (const person of [admin, groupAdmin]) expect(await eventsFor(app.notifications.shiftCancelled.id, person)).toHaveLength(1);
  });

  test("an admin who removes someone is not notified; the other admins are", async () => {
    const assignmentId = await internalId("shift_assignments", colleagueSoon.id);
    expect((await send("DELETE", `/api/venue/venues/${venueId}/assignments/${colleagueSoon.id}`, admin.cookie)).status).toBe(200);

    const events = await eventsFor(app.notifications.shiftCancelled.id, groupAdmin);
    expect(events).toHaveLength(2);
    expect(events[1]!.title).toMatch(new RegExp(`^${colleague.name} removed from .+ · Harbor Cafe$`));
    expect(events[1]!.idempotency_key).toBe(noticeKeys.cancelled(assignmentId));
    expect(await eventsFor(app.notifications.shiftCancelled.id, admin)).toHaveLength(1);
  });

  test("a past sign-up leaves without a notice", async () => {
    const [venue] = await sql<{ id: string }[]>`SELECT id FROM venue.venues WHERE short_id = ${venueId}`;
    const shortId = newShortId();
    await sql`
      INSERT INTO venue.shift_assignments (short_id, venue_id, user_id, starts_at, ends_at)
      VALUES (${shortId}, ${venue!.id}::uuid, ${staff.id}::uuid, now() - INTERVAL '3 hours', now() - INTERVAL '1 hour')
    `;
    expect((await send("DELETE", `/api/venue/venues/${venueId}/assignments/${shortId}`, staff.cookie)).status).toBe(200);
    expect(await eventsFor(app.notifications.shiftCancelled.id, groupAdmin)).toHaveLength(2);
  });

  test("the email ends with the absolute link to the shift", async () => {
    const email = await NOTIFICATIONS.shiftReminder.email!(
      {
        venueId,
        venueName: "Harbor Cafe",
        timezone: TZ,
        shiftTitle: "Evening bar",
        startsAt: colleagueSoon.startsAt,
        endsAt: colleagueSoon.endsAt,
        assignmentId: colleagueSoon.id,
      },
      { locale: "en" },
    );
    expect(email.subject).toMatch(/^Your shift .+ · Harbor Cafe$/);
    expect(email.content).toMatch(
      new RegExp(`Open in Venues: https?://\\S+/app/venue/${venueId}/shifts\\?cd=${soonSlot.date}&shift=a:${colleagueSoon.id}$`),
    );
  });

  test("the Venue scheduler runs a scan on demand and stops cleanly", async () => {
    await shiftNoticeScheduler.start();
    await shiftNoticeScheduler.start();
    const scheduler = lazySync((sync) => sync.scheduler({ id: "venue", delivery: { maxAttempts: 3, backoffMs: [10_000, 60_000] } }))();
    const info = await scheduler.get({ id: "venue:shift-notices" });
    expect(info).toEqual(expect.objectContaining({ cron: "*/15 * * * *", misfire: "latest", timezone: "UTC" }));
    const { runId } = await scheduler.runNow({ id: "venue:shift-notices", requestId: crypto.randomUUID() });
    expect(await scheduler.awaitRun({ id: "venue:shift-notices", runId, timeoutMs: 30_000 })).toEqual({ completed: true });
    await shiftNoticeScheduler.stop();
    await shiftNoticeScheduler.stop();
    // The scan found every notice sent already.
    expect(await eventsFor(app.notifications.shiftReminder.id, colleague)).toHaveLength(1);
  });
});
