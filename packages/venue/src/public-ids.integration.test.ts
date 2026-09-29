import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { settings } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import apiRoutes from "./api";
import "./frontend/ssr-test-plugin";
import { newShortId } from "./lib/short-id";

const { default: pageRoutes } = await import("./frontend");

const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(30_000);

/** The Venue request surface as `src/index.ts` mounts it; pages get an empty app registry instead of the live watcher. */
const venueApp = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .route("/api/venue", apiRoutes)
  .route("/app/venue", pageRoutes);

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Caller = { cookie?: string; authorization?: string };

/** One request against a declared route pattern; `params` names the saved ID that fills each path parameter, `onBody` saves or checks the response. */
type Step = {
  method: Method;
  route: string;
  params?: Record<string, string>;
  query?: string;
  body?: unknown;
  as?: "anonymous" | "apiKey";
  status: number;
  onBody?: (body: unknown) => void;
};

/** Path parameters the server resolves as Venue resource IDs; built-in template keys, calendar tokens, platform UUIDs, and page selection state are not. */
const takesVenueResourceId = (route: string, param: string) =>
  ["id", "resourceId", "templateId", "assignmentId"].includes(param) && !route.startsWith("/api/venue/templates/");

/** Every declared route, as `METHOD /path`; routes without an ID parameter can still return Venue records. */
const declaredRoutes = (): string[] =>
  [...new Set(venueApp.routes.filter((route) => route.method !== "ALL").map((route) => `${route.method} ${route.path}`))].sort();

const dateInDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();

const send = (method: Method, path: string, caller: Caller, body?: unknown) =>
  venueApp.request(path, {
    method,
    headers: {
      ...caller,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      // Public feedback is limited per address; a fresh documentation address keeps each request independent.
      "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const fill = (route: string, values: (param: string) => string | undefined): string =>
  route.replace(/:(\w+)/g, (_match, param: string) => {
    const value = values(param);
    if (!value) throw new Error(`Missing ${param} for ${route}`);
    return encodeURIComponent(value);
  });

/** Internal UUIDs of every Venue row the user administers, keyed by the public ID of the same row. */
const internalIdsOwnedBy = async (userId: string): Promise<Map<string, string>> => {
  const rows = await sql<{ id: string; short_id: string }[]>`
    WITH owned AS (
      SELECT va.venue_id AS id FROM venue.venue_access va JOIN auth.access a ON a.id = va.access_id WHERE a.user_id = ${userId}::uuid
    )
    SELECT id::text, short_id FROM venue.venues WHERE id IN (SELECT id FROM owned)
    UNION ALL SELECT id::text, short_id FROM venue.opening_rules WHERE venue_id IN (SELECT id FROM owned)
    UNION ALL SELECT id::text, short_id FROM venue.date_overrides WHERE venue_id IN (SELECT id FROM owned)
    UNION ALL SELECT id::text, short_id FROM venue.shift_templates WHERE venue_id IN (SELECT id FROM owned)
    UNION ALL SELECT id::text, short_id FROM venue.shift_assignments WHERE venue_id IN (SELECT id FROM owned)
    UNION ALL SELECT id::text, short_id FROM venue.public_sections WHERE venue_id IN (SELECT id FROM owned)
  `;
  return new Map(rows.map((row) => [row.short_id, row.id]));
};

const insertUser = async (label: string): Promise<string> => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`venue-${label}-${suffix}`}, 'local', 'user', ${`Venue ${label}`}, ${`venue-${label}-${suffix}@example.test`})
    RETURNING id
  `;
  return row!.id;
};

const sessionFor = async (userId: string): Promise<Caller> => ({ cookie: `session_token=${await createTestSession(userId)}` });

/** Removes the owner's Venues with their API keys, then the test users. */
const removeTestData = async (ownerId: string, ...otherUserIds: string[]) => {
  const owned = await sql<{ id: string }[]>`
    SELECT va.venue_id::text AS id FROM venue.venue_access va JOIN auth.access a ON a.id = va.access_id WHERE a.user_id = ${ownerId}::uuid
  `;
  for (const { id } of owned) {
    await sql`DELETE FROM auth.service_accounts WHERE app_id = 'venue' AND resource_id = ${id}`;
    await sql`DELETE FROM venue.venues WHERE id = ${id}::uuid`;
  }
  for (const userId of [ownerId, ...otherUserIds]) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
};

suite("Venue routes with public IDs", () => {
  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
  });

  test("every route accepts public IDs, rejects internal UUIDs, and never returns one", async () => {
    const ownerId = await insertUser("owner");
    const staffId = await insertUser("staff");
    const owner = await sessionFor(ownerId);
    const ids: Record<string, string> = {};
    const saveId = (name: string) => (body: unknown) => {
      ids[name] = (body as { id: string }).id;
    };
    const internal = new Map<string, string>();
    const bodies: string[] = [];
    const slug = `harbor-cafe-${ownerId.slice(0, 8)}`;
    const shiftDate = dateInDays(8);
    const freeStart = new Date(Date.now() + 14 * 86_400_000);

    try {
      ids.feedbackView = "feedback";

      const venue = { id: "venue" };
      const steps: Step[] = [
        {
          method: "POST",
          route: "/api/venue/venues",
          body: { name: "Harbor Cafe", slug },
          status: 201,
          onBody: (body) => {
            saveId("venue")(body);
            expect(ids.venue).toMatch(/^[0-9A-Za-z]{6}$/);
          },
        },
        {
          method: "GET",
          route: "/api/venue/calendar/my",
          status: 200,
          onBody: (body) => {
            ids.calendarToken = new URL((body as { href: string }).href).pathname.split("/").pop()!;
          },
        },
        {
          method: "GET",
          route: "/api/venue/templates",
          status: 200,
          onBody: (body) => {
            ids.builtInTemplate = (body as { id: string }[])[0]!.id;
          },
        },
        {
          method: "POST",
          route: "/api/venue/templates/:templateId",
          params: { templateId: "builtInTemplate" },
          body: { name: "Harbor Kiosk" },
          status: 201,
          onBody: saveId("templateVenue"),
        },
        {
          method: "GET",
          route: "/api/venue/venues/:id/dashboard",
          params: venue,
          query: "?slotDays=14&includeFeedbackEntries=true",
          status: 200,
        },
        {
          method: "PATCH",
          route: "/api/venue/venues/:id",
          params: venue,
          body: { name: "Harbor Cafe", slug, description: "Coffee by the water" },
          status: 200,
        },
        {
          method: "POST",
          route: "/api/venue/venues/:id/opening-rules",
          params: venue,
          body: { weekday: 1, startTime: "09:00", endTime: "17:00" },
          status: 201,
          onBody: saveId("rule"),
        },
        {
          method: "PATCH",
          route: "/api/venue/venues/:id/opening-rules/:resourceId",
          params: { id: "venue", resourceId: "rule" },
          body: { weekday: 1, startTime: "10:00", endTime: "18:00" },
          status: 200,
        },
        {
          method: "DELETE",
          route: "/api/venue/venues/:id/opening-rules/:resourceId",
          params: { id: "venue", resourceId: "rule" },
          status: 200,
        },
        {
          method: "POST",
          route: "/api/venue/venues/:id/overrides",
          params: venue,
          body: { date: dateInDays(20), kind: "closed" },
          status: 201,
          onBody: saveId("override"),
        },
        {
          method: "PATCH",
          route: "/api/venue/venues/:id/overrides/:resourceId",
          params: { id: "venue", resourceId: "override" },
          body: { date: dateInDays(20), kind: "open", startTime: "12:00", endTime: "14:00" },
          status: 200,
        },
        {
          method: "DELETE",
          route: "/api/venue/venues/:id/overrides/:resourceId",
          params: { id: "venue", resourceId: "override" },
          status: 200,
        },
        {
          method: "POST",
          route: "/api/venue/venues/:id/templates",
          params: venue,
          body: { weekday: weekdayOf(shiftDate), title: "Morning bar", startTime: "10:00", endTime: "12:00", maxPeople: 3 },
          status: 201,
          onBody: saveId("shift"),
        },
        {
          method: "POST",
          route: "/api/venue/venues/:id/templates/batch",
          params: venue,
          body: {
            templates: [2, 4].map((weekday) => ({ weekday, title: "Evening bar", startTime: "18:00", endTime: "21:00" })),
          },
          status: 201,
          onBody: (body) => {
            const created = body as { id: string; weekday: number }[];
            expect(created.map((template) => template.weekday)).toEqual([2, 4]);
            for (const template of created) expect(template.id).toMatch(/^[0-9A-Za-z]{6}$/);
          },
        },
        {
          method: "PATCH",
          route: "/api/venue/venues/:id/templates/:resourceId",
          params: { id: "venue", resourceId: "shift" },
          body: { weekday: weekdayOf(shiftDate), title: "Morning bar", startTime: "10:00", endTime: "12:30", maxPeople: 3 },
          status: 200,
        },
        {
          method: "POST",
          route: "/api/venue/venues/:id/templates/:templateId/signup",
          params: { id: "venue", templateId: "shift" },
          body: { date: shiftDate },
          status: 201,
          onBody: saveId("assignment"),
        },
        {
          method: "POST",
          route: "/api/venue/venues/:id/templates/:templateId/signup-weeks",
          params: { id: "venue", templateId: "shift" },
          body: { date: dateInDays(15), weeks: 2 },
          status: 201,
        },
        {
          method: "POST",
          route: "/api/venue/venues/:id/free-signup",
          params: venue,
          body: { startsAt: freeStart.toISOString(), endsAt: new Date(freeStart.getTime() + 3_600_000).toISOString() },
          status: 201,
        },
        {
          method: "POST",
          route: "/api/venue/venues/:id/sections",
          params: venue,
          body: { kind: "notice", title: "Opening week", content: { text: "Free refills all week." } },
          status: 201,
          onBody: saveId("section"),
        },
        {
          method: "PATCH",
          route: "/api/venue/venues/:id/sections/:resourceId",
          params: { id: "venue", resourceId: "section" },
          body: { kind: "notice", title: "Opening week", content: { text: "Free refills until Friday." } },
          status: 200,
        },
        {
          method: "POST",
          route: "/api/venue/public/:id/feedback",
          params: venue,
          body: { rating: 4, comment: "Great coffee" },
          as: "anonymous",
          status: 201,
        },
        // The key is bound to the internal Venue ID, so the key list, settings context, and pages below must not repeat it.
        {
          method: "POST",
          route: "/api/venue/venues/:id/api-keys",
          params: venue,
          body: { name: "Lobby display", permission: "read" },
          status: 201,
          onBody: (body) => {
            const key = body as { credential: { id: string }; token: string };
            ids.credential = key.credential.id;
            ids.apiKey = key.token;
          },
        },
        {
          method: "GET",
          route: "/api/venue/venues/:id/api-keys",
          params: venue,
          status: 200,
          onBody: (body) => expect((body as { items: unknown[] }).items).toHaveLength(1),
        },
        {
          method: "GET",
          route: "/api/venue/venues/:id/settings-context",
          params: venue,
          status: 200,
          onBody: (body) => expect((body as { apiKeys: unknown[] }).apiKeys).toHaveLength(1),
        },
        // A resource-bound Venue API key reaches the same resolver as a browser session.
        { method: "GET", route: "/api/venue/venues/:id/settings-context", params: venue, as: "apiKey", status: 200 },
        // Pages render while the Venue has hours, shifts, assignments, sections, feedback, and an API key.
        { method: "GET", route: "/app/venue/:id", params: venue, status: 302 },
        { method: "GET", route: "/app/venue/:id/:view", params: { id: "venue", view: "feedbackView" }, status: 200 },
        { method: "GET", route: "/app/venue/:id/public-sections/:sectionId", params: { id: "venue", sectionId: "section" }, status: 200 },
        { method: "GET", route: "/app/venue/public/:id", params: venue, as: "anonymous", status: 200 },
        { method: "GET", route: "/app/venue/public/:id/feedback", params: venue, as: "anonymous", status: 200 },
        { method: "GET", route: "/api/venue/public/:id/status", params: venue, as: "anonymous", status: 200 },
        { method: "GET", route: "/api/venue/calendar/:token", params: { token: "calendarToken" }, as: "anonymous", status: 200 },
        {
          method: "POST",
          route: "/api/venue/calendar/my/renew",
          status: 200,
          onBody: (body) => {
            const renewed = new URL((body as { href: string }).href).pathname.split("/").pop()!;
            expect(renewed).not.toBe(ids.calendarToken);
            ids.calendarToken = renewed;
          },
        },
        // Routes without an ID parameter list the same populated Venues.
        {
          method: "GET",
          route: "/api/venue/venues",
          status: 200,
          onBody: (body) => {
            const listed = (body as { venues: { id: string }[] }).venues.map((item) => item.id).sort();
            expect(listed).toEqual([ids.venue ?? "", ids.templateVenue ?? ""].sort());
          },
        },
        { method: "GET", route: "/app/venue", status: 200 },
        { method: "GET", route: "/api/venue/widget/today", status: 200 },
        { method: "GET", route: "/api/venue/schema", status: 200 },
        {
          method: "DELETE",
          route: "/api/venue/venues/:id/assignments/:assignmentId",
          params: { id: "venue", assignmentId: "assignment" },
          status: 200,
        },
        {
          method: "DELETE",
          route: "/api/venue/venues/:id/templates/:resourceId",
          params: { id: "venue", resourceId: "shift" },
          status: 200,
        },
        {
          method: "DELETE",
          route: "/api/venue/venues/:id/sections/:resourceId",
          params: { id: "venue", resourceId: "section" },
          status: 200,
        },
        { method: "GET", route: "/api/venue/venues/:id/access", params: venue, status: 200 },
        {
          method: "POST",
          route: "/api/venue/venues/:id/access",
          params: venue,
          body: { principal: { type: "user", userId: staffId }, permission: "read" },
          status: 201,
          onBody: saveId("access"),
        },
        {
          method: "PATCH",
          route: "/api/venue/venues/:id/access/:accessId",
          params: { id: "venue", accessId: "access" },
          body: { permission: "write" },
          status: 200,
        },
        { method: "DELETE", route: "/api/venue/venues/:id/access/:accessId", params: { id: "venue", accessId: "access" }, status: 200 },
        {
          method: "DELETE",
          route: "/api/venue/venues/:id/api-keys/:credentialId",
          params: { id: "venue", credentialId: "credential" },
          status: 200,
        },
        { method: "DELETE", route: "/api/venue/venues/:id", params: { id: "templateVenue" }, status: 200 },
        { method: "DELETE", route: "/api/venue/venues/:id", params: venue, status: 200 },
      ];

      for (const step of steps) {
        const label = `${step.method} ${step.route}`;
        const caller = step.as === "anonymous" ? {} : step.as === "apiKey" ? { authorization: `Bearer ${ids.apiKey}` } : owner;
        const publicValue = (param: string) => ids[step.params?.[param] ?? ""];
        for (const [publicId, internalId] of await internalIdsOwnedBy(ownerId)) internal.set(publicId, internalId);

        // Internal UUIDs are not a second way in. API ID parameters use the public ID schema, so a UUID fails
        // validation (400); pages resolve the ID and do not find a UUID (404).
        for (const param of Object.keys(step.params ?? {}).filter((name) => takesVenueResourceId(step.route, name))) {
          const path = fill(step.route, (name) => (name === param ? internal.get(publicValue(name) ?? "") : publicValue(name)));
          const rejected = await send(step.method, `${path}${step.query ?? ""}`, caller, step.body);
          expect({ label, param, status: rejected.status }).toEqual({ label, param, status: step.route.startsWith("/app/") ? 404 : 400 });
        }

        const response = await send(step.method, `${fill(step.route, publicValue)}${step.query ?? ""}`, caller, step.body);
        const text = await response.text();
        expect({ label, status: response.status, body: response.status === step.status ? "" : text.slice(0, 2_000) }).toEqual({
          label,
          status: step.status,
          body: "",
        });
        bodies.push(text);
        step.onBody?.(JSON.parse(text));
      }

      expect([...new Set(steps.map((step) => `${step.method} ${step.route}`))].sort()).toEqual(declaredRoutes());
      expect(internal.size).toBeGreaterThan(0);
      for (const internalId of internal.values()) {
        for (const body of bodies) expect(body).not.toContain(internalId);
      }
    } finally {
      await removeTestData(ownerId, staffId);
    }
  });

  test("API routes and pages deny callers below the required permission", async () => {
    const ownerId = await insertUser("owner");
    const outsiderId = await insertUser("outsider");
    const readerId = await insertUser("reader");
    const owner = await sessionFor(ownerId);
    const slug = (name: string) => `${name}-${ownerId.slice(0, 8)}`;
    const createVenue = async (name: string, venueSlug: string): Promise<string> => {
      const response = await send("POST", "/api/venue/venues", owner, { name, slug: venueSlug });
      expect(response.status).toBe(201);
      return ((await response.json()) as { id: string }).id;
    };

    try {
      const cafe = await createVenue("Harbor Cafe", slug("harbor-cafe"));
      const bakery = await createVenue("Dockside Bakery", slug("dockside-bakery"));
      const grant = { principal: { type: "user", userId: readerId }, permission: "read" };
      expect((await send("POST", `/api/venue/venues/${cafe}/access`, owner, grant)).status).toBe(201);
      const key = await send("POST", `/api/venue/venues/${cafe}/api-keys`, owner, { name: "Lobby display", permission: "read" });
      expect(key.status).toBe(201);
      const callers = {
        outsider: await sessionFor(outsiderId),
        reader: await sessionFor(readerId),
        "cafe key": { authorization: `Bearer ${((await key.json()) as { token: string }).token}` },
      };
      const venueInput = { name: "Harbor Cafe", slug: slug("harbor-cafe") };
      const freeStart = new Date(Date.now() + 14 * 86_400_000);
      const freeSlot = { startsAt: freeStart.toISOString(), endsAt: new Date(freeStart.getTime() + 3_600_000).toISOString() };
      const notice = { kind: "notice", title: "Closed on Monday", content: { text: "We reopen on Tuesday." } };

      // Signed-out requests never reach the permission check, and the allowed requests show that the grant and
      // the key work, so each 403 comes from the permission the route requires.
      const checks: [caller: keyof typeof callers, method: Method, path: string, body: unknown, status: number][] = [
        ["outsider", "GET", `/api/venue/venues/${cafe}/dashboard`, undefined, 403],
        ["outsider", "GET", `/app/venue/${cafe}/shifts`, undefined, 403],
        ["outsider", "GET", `/api/venue/venues/${newShortId()}/dashboard`, undefined, 404],
        ["reader", "GET", `/api/venue/venues/${cafe}/dashboard`, undefined, 200],
        ["reader", "GET", `/app/venue/${cafe}/shifts`, undefined, 200],
        ["reader", "POST", `/api/venue/venues/${cafe}/free-signup`, freeSlot, 403],
        ["reader", "PATCH", `/api/venue/venues/${cafe}`, venueInput, 403],
        ["reader", "POST", `/api/venue/venues/${cafe}/sections`, notice, 403],
        [
          "reader",
          "POST",
          `/api/venue/venues/${cafe}/templates/batch`,
          { templates: [{ weekday: 1, title: "Morning bar", startTime: "09:00", endTime: "12:00" }] },
          403,
        ],
        ["reader", "GET", `/api/venue/venues/${cafe}/access`, undefined, 403],
        ["reader", "POST", `/api/venue/venues/${cafe}/api-keys`, { name: "Reader key", permission: "read" }, 403],
        ["reader", "DELETE", `/api/venue/venues/${cafe}`, undefined, 403],
        ["cafe key", "GET", `/api/venue/venues/${cafe}/dashboard`, undefined, 200],
        ["cafe key", "PATCH", `/api/venue/venues/${cafe}`, venueInput, 403],
        ["cafe key", "GET", `/api/venue/venues/${bakery}/dashboard`, undefined, 403],
        // A Venue key acts for no person, so it cannot replace anyone's calendar link.
        ["cafe key", "POST", "/api/venue/calendar/my/renew", undefined, 403],
      ];
      for (const [caller, method, path, body, status] of checks) {
        const response = await send(method, path, callers[caller], body);
        expect({ caller, method, path, status: response.status }).toEqual({ caller, method, path, status });
      }
    } finally {
      await removeTestData(ownerId, outsiderId, readerId);
    }
  });
});
