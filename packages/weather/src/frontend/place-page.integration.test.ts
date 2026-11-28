import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@k2b/cloud";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { weatherService } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { WeatherDataPayload } from "../contracts";

const root = mkdtempSync(join(tmpdir(), "weather-place-page-integration-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { ssr } = await import("../config");
const { default: placePage } = await import("./[id]/page");

const suite = suiteFor("database", "nats", "valkey");
const tag = crypto.randomUUID().slice(0, 8);
const created: string[] = [];

// The provider's answer for every place: the forecast comes from Bright Sky through the cache, never from the database.
const now = new Date().toISOString();
const forecast: WeatherDataPayload = {
  current: {
    temperature: 8.4,
    icon: "cloudy",
    cloudCover: 85,
    windSpeed: 17,
    windGust: null,
    windDirection: 220,
    humidity: 78,
    precipitation: 0,
    pressure: 1009,
    visibility: 18_500,
    dewPoint: 4.8,
    sunshine: 0,
    stationName: "Ulm-Mähringen",
    timestamp: now,
  },
  hourly: Array.from({ length: 12 }, (_, index) => ({
    timestamp: new Date(Date.parse(now) + index * 3_600_000).toISOString(),
    temperature: 8 - index * 0.4,
    icon: "rain",
    precipitation: 0.2,
    precipitationProbability: index * 8,
    windSpeed: 10,
    cloudCover: 80,
  })),
  daily: Array.from({ length: 7 }, (_, index) => ({
    date: new Date(Date.parse(now) + index * 86_400_000).toISOString().slice(0, 10),
    icon: "rain",
    tempMin: 1 + index,
    tempMax: 7 + index,
    precipitation: 2,
    precipitationProbability: 60,
    sunshine: 90,
  })),
};

/** The page's own statements, as the meter keeps their first 120 characters: one count and one page of saved places. */
const placeStatements = (statements: string[]) => statements.filter((statement) => statement.includes("FROM weather_locations"));

suite("the weather place page's statement budget and payload (integration)", () => {
  afterAll(async () => {
    for (const id of created) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("the SSR page reads the saved places in one count and one page, four statements in all, and states its payload", async () => {
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, last_login_local)
      VALUES (${`weather-page-${tag}`}, 'local', 'user', ${`Ada ${tag}`}, now())
      RETURNING id`;
    created.push(user!.id);
    const places: string[] = [];
    for (const name of ["Ulm", "Berlin", "Hamburg", "München", "Freiburg im Breisgau", "Sylt", "Garmisch-Partenkirchen"]) {
      const saved = await weatherService.location.saved.create({ userId: user!.id, data: { name, lat: 48.4, lon: 9.99 } });
      if (!saved.ok) throw new Error(saved.error.code);
      places.push(saved.data.id);
    }
    const forecasts = spyOn(weatherService.forecast, "get").mockResolvedValue(forecast as never);
    const rail = stubRailSnapshot();
    const headers = { cookie: `session_token=${await createTestSession(user!.id)}`, "x-forwarded-for": uniqueCallerAddress() };
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("runtime", { apps: [] });
      await next();
    });
    // the route as Weather mounts it: the user check of the route, then the page
    app.route("/", new Hono<AuthContext>().get("/app/weather/:id", auth.requireRole("user", ssr.access), ...placePage));
    const page = () => app.request(`/app/weather/${places[0]}`, { headers });
    try {
      // the session and the settings the page reads are warm, as on every running server
      expect((await page()).status).toBe(200);
      const meter = await meterSql();
      let html = "";
      try {
        const statements = await meter.during(async () => {
          const response = await page();
          expect(response.status).toBe(200);
          html = await response.text();
        });
        // one count and one page of the saved places (index idx_weather_locations_user_created: user_id, created_at, id)
        expect(placeStatements(statements)).toHaveLength(2);
        // and besides them only the signed-in person and the shell's screen preferences, as for every page: 4 in all
        expect(statements).toHaveLength(4);
        // every place's forecast comes from the provider cache, one call per place, none from the database
        expect(statements.filter((statement) => statement.includes("weather")).length).toBe(2);
      } finally {
        await meter.close();
      }
      // the screen's data: the island's serialized props as the page sends them (seven places, one open)
      const props = html.match(/data-props="([^"]*)"[^>]*data-file="WeatherScreen\.island\.tsx"/)?.[1];
      expect(props).toBeDefined();
      console.log(`weather place page: html ${html.length} B, island props ${props!.length} B`);
      expect(html).toContain(`Ulm`);
      expect(forecasts).toHaveBeenCalledTimes(14);
    } finally {
      rail.mockRestore();
      forecasts.mockRestore();
    }
  }, 60_000);
});
