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
import type { PublicStatus, Venue } from "./contracts";
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

const send = (method: "GET" | "POST", path: string, cookie: string, body?: unknown) =>
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

/** The date key `days` calendar days after `date`. */
const addDays = (date: string, days: number): string =>
  new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + days, 12))
    .toISOString()
    .slice(0, 10);

suite("Venue public page shows changed hours in advance and follows the theme", () => {
  let admin: { id: string; cookie: string };
  let venue: Venue;
  let today: string;

  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
    const suffix = crypto.randomUUID();
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${`venue-public-${suffix}`}, 'local', 'user', 'Venue public admin', ${`venue-public-${suffix}@example.test`})
      RETURNING id
    `;
    admin = { id: row!.id, cookie: `session_token=${await createTestSession(row!.id)}` };
    venue = JSON.parse(
      await expectStatus(
        await send("POST", "/api/venue/venues", admin.cookie, {
          name: "Lakeside Kiosk",
          slug: `lakeside-kiosk-${admin.id.slice(0, 8)}`,
          timezone: "Europe/Berlin",
        }),
        201,
        "create venue",
      ),
    ) as Venue;
    today = dates.formatDateKey(new Date(), { timeZone: "Europe/Berlin" });
    for (const [date, body] of [
      [addDays(today, -1), { kind: "closed", note: "Yesterday" }],
      [addDays(today, 5), { kind: "closed", note: "Public holiday" }],
      [addDays(today, 12), { kind: "open", startTime: "18:00", endTime: "23:00", note: "Long night" }],
      [addDays(today, 30), { kind: "closed", note: "Too far ahead" }],
    ] as const) {
      await expectStatus(
        await send("POST", `/api/venue/venues/${venue.id}/overrides`, admin.cookie, { date, ...body }),
        201,
        `exception ${date}`,
      );
    }
  });

  afterAll(async () => {
    await sql`
      DELETE FROM venue.venues WHERE id IN (
        SELECT va.venue_id FROM venue.venue_access va JOIN auth.access a ON a.id = va.access_id WHERE a.user_id = ${admin.id}::uuid
      )
    `;
    await sql`DELETE FROM auth.users WHERE id = ${admin.id}::uuid`;
  });

  test("the public status lists closed days and special openings of the next 30 days to anonymous visitors", async () => {
    const status = JSON.parse(
      await expectStatus(await send("GET", `/api/venue/public/${venue.id}/status`, ""), 200, "status"),
    ) as PublicStatus;
    expect(status.upcomingExceptions).toEqual([
      { date: addDays(today, 5), kind: "closed", startTime: null, endTime: null, note: "Public holiday" },
      { date: addDays(today, 12), kind: "open", startTime: "18:00", endTime: "23:00", note: "Long night" },
    ]);
  });

  test("the page names them under Changed hours before the day", async () => {
    const html = await expectStatus(await send("GET", `/app/venue/public/${venue.id}`, ""), 200, "public page");
    expect(html).toContain("Changed hours");
    expect(html).toContain("Closed · Public holiday");
    expect(html).toContain("Special opening 18:00–23:00 · Long night");
    expect(html).not.toContain("Too far ahead");
  });

  test("the scrollable page follows the visitor's theme; the monitor is always dark", async () => {
    const htmlClass = async (path: string, cookie: string) =>
      (await expectStatus(await send("GET", path, cookie), 200, `${path} ${cookie}`)).match(/<html[^>]*>/)?.[0] ?? "";
    const page = `/app/venue/public/${venue.id}`;

    expect(await htmlClass(page, "")).toContain('class="light"');
    expect(await htmlClass(page, "theme=dark")).toContain('class="dark"');
    expect(await htmlClass(`${page}/feedback`, "theme=dark")).toContain('class="dark"');
    for (const cookie of ["", "theme=light"]) {
      const monitor = await htmlClass(`${page}?height=full`, cookie);
      expect({ cookie, dark: monitor.includes('class="dark"'), fixed: monitor.includes("data-theme-fixed") }).toEqual({
        cookie,
        dark: true,
        fixed: true,
      });
    }
  });
});
