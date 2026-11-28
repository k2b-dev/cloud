import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { settings } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { dates } from "@k2b/stdlib";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../scripts/fixtures/caller-address";
import { meterSql } from "../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import apiRoutes from "./api";
import type { Venue } from "./contracts";
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

const send = (method: "GET" | "POST" | "PATCH", path: string, cookie: string, body?: unknown) =>
  venueApp.request(path, {
    method,
    headers: {
      cookie,
      "accept-language": "de",
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

/** The SQL a statement runs, without its parameters, as the meter records it: enough to tell the reads apart. */
const tables = (statements: string[]) =>
  statements.map((statement) => statement.match(/\bFROM\s+([\w.]+)/i)?.[1] ?? statement.slice(0, 40)).toSorted();

suite("Venue guest pages load their first view in one bounded read", () => {
  let admin: { id: string; cookie: string };
  let venue: Venue;

  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
    const suffix = crypto.randomUUID();
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${`venue-guest-${suffix}`}, 'local', 'user', 'Venue guest admin', ${`venue-guest-${suffix}@example.test`})
      RETURNING id
    `;
    admin = { id: row!.id, cookie: `session_token=${await createTestSession(row!.id)}` };
    venue = JSON.parse(
      await expectStatus(
        await send("POST", "/api/venue/venues", admin.cookie, {
          name: "Campus-Café Nord",
          slug: `campus-cafe-nord-${admin.id.slice(0, 8)}`,
          timezone: "Europe/Berlin",
          openMode: "regular",
        }),
        201,
        "create venue",
      ),
    ) as Venue;
    for (const weekday of [0, 1, 2, 3, 4, 5, 6])
      await expectStatus(
        await send("POST", `/api/venue/venues/${venue.id}/opening-rules`, admin.cookie, { weekday, startTime: "08:00", endTime: "18:00" }),
        201,
        `rule ${weekday}`,
      );
    const today = dates.formatDateKey(new Date(), { timeZone: "Europe/Berlin" }); // real clock: the server reads it too
    const later = dates.formatDateKey(new Date(Date.parse(`${today}T12:00:00Z`) + 3 * 86_400_000), { timeZone: "UTC" });
    await expectStatus(
      await send("POST", `/api/venue/venues/${venue.id}/overrides`, admin.cookie, { date: later, kind: "closed", note: "Inventur" }),
      201,
      "closed day",
    );
    for (const [kind, title, content] of [
      ["notice", "Nur noch Pfandbecher", { text: "Ab Dezember im Mehrwegbecher." }],
      ["menu", "Heute auf der Karte", { items: [{ name: "Linsen-Dal", price: "4,20 €" }] }],
      ["markdown", "Über uns", { markdown: "Ehrenamtlich betrieben." }],
      ["links", "Kontakt", { links: [{ label: "Anrufen", href: "tel:+493012345678" }] }],
    ] as const)
      await expectStatus(
        await send("POST", `/api/venue/venues/${venue.id}/sections`, admin.cookie, { kind, title, content, enabled: true }),
        201,
        title,
      );
  });

  afterAll(async () => {
    await sql`
      DELETE FROM venue.venues WHERE id IN (
        SELECT va.venue_id FROM venue.venue_access va JOIN auth.access a ON a.id = va.access_id WHERE a.user_id = ${admin.id}::uuid
      )
    `;
    await sql`DELETE FROM auth.users WHERE id = ${admin.id}::uuid`;
  });

  test("the guest page: a fixed number of statements, no cache, the hero and the sections in the first response", async () => {
    const page = `/app/venue/public/${venue.id}`;
    // the settings and sessions the page reads are warm, as on every running server
    await expectStatus(await send("GET", page, ""), 200, "warm");
    const meter = await meterSql();
    try {
      let html = "";
      let cache = "";
      const statements = await meter.during(async () => {
        const response = await send("GET", page, "");
        cache = response.headers.get("cache-control") ?? "";
        html = await expectStatus(response, 200, "guest page");
      });
      // the venue, its rules, the exceptions of 30 days, the shift templates and assignments of 14 days, the sections,
      // and the public IDs the projection gives the venue, its rules and its sections
      expect(tables(statements)).toEqual(GUEST_READS);
      expect(cache).toBe("no-store");
      expect(html).toContain("Öffnungszeiten");
      expect(html).toContain("Heute auf der Karte");
      expect(html).toContain("Inventur");
      expect(html).toContain('href="tel:+493012345678"');
      expect(html).toContain("+49 30 12345678");
      // the guest page needs no script of its own: no island in its content
      const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
      expect(main).not.toContain("solid-island");
      console.info(`guest page: ${statements.length} statements, ${html.length} bytes of HTML`);
    } finally {
      await meter.close();
    }
  });

  test("the feedback page: the same read, and the form island carries three strings", async () => {
    const page = `/app/venue/public/${venue.id}/feedback`;
    await expectStatus(await send("GET", page, ""), 200, "warm");
    const meter = await meterSql();
    try {
      let html = "";
      const statements = await meter.during(async () => {
        html = await expectStatus(await send("GET", page, ""), 200, "feedback page");
      });
      expect(tables(statements)).toEqual(GUEST_READS);
      expect(html.match(/<solid-island[^>]*data-file="GuestFeedback\.island\.tsx"/g)?.length).toBe(1);
      const props = html.match(/data-props="([^"]*)" data-file="GuestFeedback\.island\.tsx"/)?.[1] ?? "";
      expect(props.length).toBeGreaterThan(0);
      expect(props.length).toBeLessThan(600);
      console.info(`feedback page: ${statements.length} statements, island props ${props.length} bytes, ${html.length} bytes of HTML`);
    } finally {
      await meter.close();
    }
  });

  test("sending feedback arrives; a closed venue refuses it and its page says so", async () => {
    await expectStatus(await send("POST", `/api/venue/public/${venue.id}/feedback`, "", { rating: 4, comment: "Gut" }), 201, "feedback");
    await expectStatus(
      await send("PATCH", `/api/venue/venues/${venue.id}`, admin.cookie, { ...venue, feedbackEnabled: false }),
      200,
      "close",
    );
    await expectStatus(await send("POST", `/api/venue/public/${venue.id}/feedback`, "", { rating: 4, comment: null }), 400, "closed");
    const html = await expectStatus(await send("GET", `/app/venue/public/${venue.id}/feedback`, ""), 200, "closed page");
    expect(html).toContain("Feedback ist gerade geschlossen");
    expect(html).not.toContain('data-file="GuestFeedback.island.tsx"');
    const guest = await expectStatus(await send("GET", `/app/venue/public/${venue.id}`, ""), 200, "guest page");
    expect(guest).not.toContain(">Bewerten<");
  });

  test("an unknown venue answers 404 with the page that reveals nothing", async () => {
    const html = await expectStatus(await send("GET", "/app/venue/public/Gone01", ""), 404, "unknown");
    expect(html).toContain("Diese Seite ist nicht verfügbar");
  });
});

/** The statements of one guest page's first view, by what they read; pinned, so a new read per request fails here first. */
const GUEST_READS = [
  "SELECT sa.template_id, sa.starts_at, sa.",
  "venue.date_overrides",
  "venue.opening_rules",
  "venue.opening_rules",
  "venue.public_sections",
  "venue.public_sections",
  "venue.shift_templates",
  "venue.venues",
  "venue.venues",
  "venue.venues",
  "venue.venues",
  "venue.venues",
];
