import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { logging, trace } from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import * as health from "../health";
import * as infrastructure from "./infrastructure/sections";
import * as telemetry from "./telemetry/service";

const root = mkdtempSync(join(tmpdir(), "observability-range-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");
const area = await import("./_components/ObservabilityArea");

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  roles: ["user", "admin"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Admin",
  displayName: "Ada Admin",
  mail: "admin@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

const server = () => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/admin/observability", ...handler);
  return app;
};

/** The health the page reads through the area's shared cache, and the build behind it for the sidebar's dots. */
const healthOf = (value: unknown) => [
  spyOn(health, "buildGatewayHealth").mockResolvedValue(value as never),
  spyOn(area, "readHealth").mockResolvedValue(value as never),
];

/** The text a person reads in the first HTML; drawings are no text (and their inline style stops the test parser). */
const read = (html: string) =>
  html
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

test("sources that cannot be read are named as signals and their figures say so, never zero; the window holds in every link", async () => {
  const unavailable = new Error("Fixture source unavailable");
  const spies = [
    stubRailSnapshot(),
    spyOn(health, "buildGatewayHealth").mockRejectedValue(unavailable),
    spyOn(area, "readHealth").mockRejectedValue(unavailable),
    spyOn(telemetry, "getTelemetryOverview").mockRejectedValue(unavailable),
    spyOn(telemetry, "getTelemetryTimeseries").mockResolvedValue([]),
    spyOn(telemetry, "listTelemetryRoutes").mockResolvedValue([]),
    spyOn(logging, "summary").mockRejectedValue(unavailable),
    spyOn(logging, "timeseries").mockResolvedValue([]),
    spyOn(trace, "stats").mockRejectedValue(unavailable),
    // no real backend is probed: the services' states are given
    spyOn(infrastructure, "readInfraStates").mockResolvedValue({ postgres: undefined, valkey: undefined, nats: undefined }),
  ];
  try {
    const app = server();
    const response = await app.request("/admin/observability?range=7d", { headers: { "Accept-Language": "de" } });
    const html = await response.text();
    expect(response.status, html).toBe(200);
    const text = read(html);
    expect(text).toContain("Eingeschränkte Sichtbarkeit");
    expect(text).toContain("Zeitraum Letzte 7 Tage");
    expect(text).toContain("Apps online — nicht verfügbar");
    expect(text).not.toContain("Apps online 0/0");
    // every signal leads to the v2 page that looks at it, in the same window
    expect(html).toContain('href="/admin/observability/runs?kind=job&amp;time=last-7d"');
    expect(html).toContain('href="/admin/observability/logs?time=last-7d"');
    expect(html).not.toContain("/admin/observability/jobs");
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

test("a quiet window says so; failing routes stand with their app and lead to their requests", async () => {
  const spies = [
    stubRailSnapshot(),
    ...healthOf({ apps: [{ id: "mail", name: "Mail", icon: "ti ti-mail", status: "ok", online: true }] }),
    spyOn(telemetry, "getTelemetryOverview").mockResolvedValue({
      requests: 1200,
      slowRequests: 4,
      serverErrors: 0,
      rateLimited: 0,
    } as never),
    spyOn(telemetry, "getTelemetryTimeseries").mockResolvedValue([]),
    spyOn(telemetry, "listTelemetryRoutes").mockResolvedValue([
      { appId: "mail", route: "/api/mail/send", requests: 40, errors: 2, slowRequests: 0, avgDurationMs: 80, maxDurationMs: 900 },
    ]),
    spyOn(logging, "summary").mockResolvedValue({ errors24h: 0, warnings24h: 0, total24h: 1_204 } as never),
    spyOn(logging, "timeseries").mockResolvedValue([]),
    spyOn(trace, "stats").mockResolvedValue({ runs: 3_482, failed: 0, stuck: 0 } as never),
    spyOn(infrastructure, "readInfraStates").mockResolvedValue({ postgres: "ok", valkey: "ok", nats: "ok" }),
  ];
  try {
    const html = await (await server().request("/admin/observability", { headers: { "Accept-Language": "de" } })).text();
    const text = read(html);
    expect(text).toContain("Keine aktiven Störungen");
    expect(text).toContain("keine aktiven Signale");
    expect(text).toContain("Apps online 1/1");
    // the volumes of the window beside the hero, and every app with its state beside the page
    expect(text).toContain("Läufe 3.482");
    expect(text).toContain("1 von 1 online");
    expect(text).toContain("/api/mail/send");
    expect(text).toContain("5 %");
    // a share from BAD_ROUTE_SHARE on stands in the colour of a problem
    expect(html).toMatch(/data-tone="bad"[^>]*>5\s%/);
    expect(html).toContain('href="/admin/observability/telemetry?range=24h&amp;app=mail&amp;route=%2Fapi%2Fmail%2Fsend"');
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

test("a service that did not answer and failing routes that could not be read say so in their own place", async () => {
  const spies = [
    stubRailSnapshot(),
    ...healthOf({ apps: [{ id: "mail", name: "Mail", icon: "ti ti-mail", accent: "#2563eb", status: "ok", online: true }] }),
    spyOn(telemetry, "getTelemetryOverview").mockResolvedValue({ requests: 10, slowRequests: 0, serverErrors: 0, rateLimited: 0 } as never),
    spyOn(telemetry, "getTelemetryTimeseries").mockResolvedValue([]),
    spyOn(telemetry, "listTelemetryRoutes").mockRejectedValue(new Error("Telemetry rollups unreadable")),
    spyOn(logging, "summary").mockResolvedValue({ errors24h: 0, warnings24h: 0, total24h: 0 } as never),
    spyOn(logging, "timeseries").mockResolvedValue([]),
    spyOn(trace, "stats").mockResolvedValue({ runs: 0, failed: 0, stuck: 0 } as never),
    spyOn(infrastructure, "readInfraStates").mockResolvedValue({ postgres: "ok", valkey: "bad", nats: undefined }),
  ];
  try {
    const html = await (await server().request("/admin/observability", { headers: { "Accept-Language": "de" } })).text();
    const text = read(html);
    // the side column: each service with its state in a word, one that did not answer as unavailable
    expect(text).toMatch(/Postgres Fehlerfrei[\s\S]*Valkey Eingriff erforderlich[\s\S]*NATS nicht verfügbar/);
    // the failing routes say why they are missing and offer a retry in their place
    expect(text).toContain("Telemetry rollups unreadable");
    expect(text).toContain("Erneut versuchen");
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
