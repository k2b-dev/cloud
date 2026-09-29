import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { settings } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import apiRoutes from "./api";
import type { PublicSection, PublicStatus, VenueDashboard } from "./contracts";
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

type Caller = { cookie?: string };

const send = (method: "GET" | "POST" | "PUT" | "PATCH", path: string, caller: Caller, body?: unknown) =>
  venueApp.request(path, {
    method,
    headers: {
      ...caller,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-forwarded-for": uniqueCallerAddress(),
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

const insertUser = async (label: string): Promise<string> => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`venue-${label}-${suffix}`}, 'local', 'user', ${`Venue ${label}`}, ${`venue-${label}-${suffix}@example.test`})
    RETURNING id
  `;
  return row!.id;
};

suite("Venue public page view", () => {
  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
  });

  test("admins reorder every section at once; others cannot, and a wrong list changes nothing", async () => {
    const adminId = await insertUser("admin");
    const staffId = await insertUser("staff");
    const readerId = await insertUser("reader");
    const admin = { cookie: `session_token=${await createTestSession(adminId)}` };
    const staff = { cookie: `session_token=${await createTestSession(staffId)}` };
    const reader = { cookie: `session_token=${await createTestSession(readerId)}` };
    const suffix = adminId.slice(0, 8);

    try {
      const createVenue = async (name: string, slug: string) =>
        (
          JSON.parse(await expectStatus(await send("POST", "/api/venue/venues", admin, { name, slug }), 201, `create ${name}`)) as {
            id: string;
          }
        ).id;
      const cafe = await createVenue("Harbor Cafe", `harbor-cafe-${suffix}`);
      const bakery = await createVenue("Dockside Bakery", `dockside-bakery-${suffix}`);
      const createSection = async (venueId: string, title: string, enabled = true) =>
        (
          JSON.parse(
            await expectStatus(
              await send("POST", `/api/venue/venues/${venueId}/sections`, admin, {
                kind: "notice",
                title,
                content: { text: `${title} text` },
                enabled,
              }),
              201,
              `create ${title}`,
            ),
          ) as { id: string }
        ).id;
      const week = await createSection(cafe, "Opening week");
      const lunch = await createSection(cafe, "Lunch");
      const draft = await createSection(cafe, "Winter hours", false);
      const foreign = await createSection(bakery, "Fresh bread");
      for (const [userId, permission] of [
        [staffId, "write"],
        [readerId, "read"],
      ] as const) {
        await expectStatus(
          await send("POST", `/api/venue/venues/${cafe}/access`, admin, { principal: { type: "user", userId }, permission }),
          201,
          `grant ${permission}`,
        );
      }
      const order = async () =>
        (
          JSON.parse(
            await expectStatus(await send("GET", `/api/venue/venues/${cafe}/dashboard`, admin), 200, "dashboard"),
          ) as VenueDashboard
        ).sections.map((section) => section.id);
      const reorder = (caller: Caller, sectionIds: string[]) =>
        send("PUT", `/api/venue/venues/${cafe}/sections/order`, caller, { sectionIds });
      expect(await order()).toEqual([week, lunch, draft]);

      // Staff and readers cannot reorder, even with the right list.
      await expectStatus(await reorder(staff, [draft, lunch, week]), 403, "staff reorder");
      await expectStatus(await reorder(reader, [draft, lunch, week]), 403, "reader reorder");
      // A section of another venue is not found, a list that misses or repeats a section is rejected, and none
      // of them moves anything, also not the sections listed before the wrong one.
      await expectStatus(await reorder(admin, [draft, lunch, week, foreign]), 404, "foreign section");
      await expectStatus(await reorder(admin, [draft, lunch, foreign]), 404, "foreign instead of own");
      await expectStatus(await reorder(admin, [draft, lunch]), 400, "incomplete list");
      await expectStatus(await reorder(admin, [draft, lunch, week, week]), 400, "repeated section");
      expect(await order()).toEqual([week, lunch, draft]);

      const saved = JSON.parse(await expectStatus(await reorder(admin, [draft, lunch, week]), 200, "admin reorder")) as PublicSection[];
      expect(saved.map((section) => [section.id, section.position])).toEqual([
        [draft, 1],
        [lunch, 2],
        [week, 3],
      ]);
      // The order holds after a reload, in the workspace and on the public page, which leaves the draft out.
      expect(await order()).toEqual([draft, lunch, week]);
      const status = JSON.parse(
        await expectStatus(await send("GET", `/api/venue/public/${cafe}/status`, {}), 200, "public status"),
      ) as PublicStatus;
      expect(status.sections.map((section) => section.id)).toEqual([lunch, week]);
      // The other venue keeps its section.
      const bakeryDashboard = JSON.parse(
        await expectStatus(await send("GET", `/api/venue/venues/${bakery}/dashboard`, admin), 200, "bakery dashboard"),
      ) as VenueDashboard;
      expect(bakeryDashboard.sections.map((section) => section.id)).toEqual([foreign]);
    } finally {
      await cleanUp(adminId, staffId, readerId);
    }
  });

  test("admins preview a switched-off page; old section links lead admins to the view and everyone else to the schedule", async () => {
    const adminId = await insertUser("admin");
    const staffId = await insertUser("staff");
    const admin = { cookie: `session_token=${await createTestSession(adminId)}` };
    const staff = { cookie: `session_token=${await createTestSession(staffId)}` };

    try {
      const created = await send("POST", "/api/venue/venues", admin, {
        name: "Harbor Cafe",
        slug: `harbor-cafe-${adminId.slice(0, 8)}`,
        publicEnabled: false,
      });
      const cafe = (JSON.parse(await expectStatus(created, 201, "create venue")) as { id: string }).id;
      const createSection = async (title: string, enabled: boolean) =>
        (
          JSON.parse(
            await expectStatus(
              await send("POST", `/api/venue/venues/${cafe}/sections`, admin, {
                kind: "notice",
                title,
                content: { text: `${title} text` },
                enabled,
              }),
              201,
              `create ${title}`,
            ),
          ) as { id: string }
        ).id;
      const week = await createSection("Opening week", true);
      await createSection("Winter hours", false);
      await expectStatus(
        await send("POST", `/api/venue/venues/${cafe}/access`, admin, {
          principal: { type: "user", userId: staffId },
          permission: "write",
        }),
        201,
        "grant staff",
      );

      // Visitors see nothing while the page is off; the admin previews what they will see.
      await expectStatus(await send("GET", `/api/venue/public/${cafe}/status`, {}), 404, "public status while off");
      const preview = JSON.parse(
        await expectStatus(await send("GET", `/api/venue/venues/${cafe}/public-preview`, admin), 200, "admin preview"),
      ) as PublicStatus;
      expect(preview.venue.publicEnabled).toBe(false);
      expect(preview.sections.map((section) => section.title)).toEqual(["Opening week"]);
      await expectStatus(await send("GET", `/api/venue/venues/${cafe}/public-preview`, staff), 403, "staff preview");

      const view = await expectStatus(await send("GET", `/app/venue/${cafe}/public`, admin), 200, "admin public page view");
      expect(view).toContain('data-public-layout="preview"');
      expect(view).toContain("Opening week text");

      const old = await send("GET", `/app/venue/${cafe}/public-sections/${week}`, admin);
      expect({ status: old.status, location: old.headers.get("location") }).toEqual({
        status: 302,
        location: `/app/venue/${cafe}/public?section=${week}`,
      });
      const marked = await expectStatus(await send("GET", old.headers.get("location")!, admin), 200, "marked section");
      expect(marked).toMatch(new RegExp(`data-section-row="${week}" data-selected=""`));

      for (const path of [`/app/venue/${cafe}/public-sections/${week}`, `/app/venue/${cafe}/public`]) {
        const response = await send("GET", path, staff);
        expect({ path, status: response.status, location: response.headers.get("location") }).toEqual({
          path,
          status: 302,
          location: `/app/venue/${cafe}/shifts`,
        });
      }
    } finally {
      await cleanUp(adminId, staffId);
    }
  });
});

/** Removes the Venues the first user administers, then the test users. */
const cleanUp = async (ownerId: string, ...otherUserIds: string[]) => {
  const owned = await sql<{ id: string }[]>`
    SELECT va.venue_id::text AS id FROM venue.venue_access va JOIN auth.access a ON a.id = va.access_id WHERE a.user_id = ${ownerId}::uuid
  `;
  for (const { id } of owned) await sql`DELETE FROM venue.venues WHERE id = ${id}::uuid`;
  for (const userId of [ownerId, ...otherUserIds]) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
};
