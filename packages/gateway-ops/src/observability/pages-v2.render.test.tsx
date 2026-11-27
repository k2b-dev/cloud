import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cloud from "@k2b/cloud";
import * as capabilityStore from "@k2b/cloud/capabilities/store";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as server from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import * as telemetry from "./telemetry/service";

// The gateway routes and the capability console on v2, from invented data: the first HTML holds the screen, its
// figures and its rows, and every number reads as the request's locale writes it.
const root = mkdtempSync(join(tmpdir(), "gateway-ops-pages-v2-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: routesPage } = await import("./gateway/page");
const { default: capabilitiesPage } = await import("./capabilities/page");

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

const app = () => {
  const hono = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  hono.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  hono.get("/admin/observability/gateway/routes", ...routesPage);
  hono.get("/admin/observability/capabilities", ...capabilitiesPage);
  return hono;
};

/** The words a person reads in the first HTML. */
const read = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const APPS = [
  { id: "mail", name: "Mail", icon: "ti ti-mail" },
  { id: "files", name: "Dateien", icon: "ti ti-folder" },
] as never;

const totals = (requests: number, errors: number) => ({ requests, errors }) as never;

test("gateway routes: the router's table with each prefix's traffic, filtered by app and search from the address", async () => {
  const spies = [
    stubRailSnapshot(),
    spyOn(cloud, "listApps").mockResolvedValue(APPS),
    spyOn(services, "latestGatewayRouteSnapshot").mockResolvedValue({
      startedAt: Date.parse("2026-11-24T05:00:00Z"),
      tableVersion: 42,
      routeCount: 3,
      routeWarnings: [{ appId: "files", prefix: "/api/files", reason: "shadowed" }],
      routes: [
        { prefix: "/api/mail", appId: "mail" },
        { prefix: "/api/mail/send", appId: "mail" },
        { prefix: "/api/files", appId: "files" },
      ],
    } as never),
    spyOn(telemetry, "getTelemetryAppTotals").mockResolvedValue(new Map([["mail", totals(1_234_567, 3)]])),
    spyOn(telemetry, "getTelemetryPrefixTotals").mockResolvedValue(
      new Map([
        ["/api/mail", totals(1_200_000, 0)],
        ["/api/mail/send", totals(34_567, 3)],
      ]),
    ),
  ];
  try {
    const all = await app().request("/admin/observability/gateway/routes", { headers: { "Accept-Language": "de" } });
    const html = await all.text();
    expect(all.status, html).toBe(200);
    expect(html).toContain('data-k2-part="Workspace"');
    const text = read(html);
    expect(text).toContain("1.234.567");
    expect(text).toContain("/api/mail/send");
    expect(text).toContain("/api/files · files: shadowed");
    expect(text).toContain("v42");

    const narrowed = read(
      await (await app().request("/admin/observability/gateway/routes?app=mail&q=send", { headers: { "Accept-Language": "de" } })).text(),
    );
    expect(narrowed).toContain("1 von 3 Routen");
    expect(narrowed).not.toContain("/api/files Dateien");
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

const execution = (id: string, status: "succeeded" | "failed", overrides: Record<string, unknown> = {}) => ({
  id,
  requestId: `request-${id}`,
  origin: "assistant",
  appId: "mail",
  capability: "mail.send",
  kind: "action",
  destructive: false,
  actorKind: "user",
  actorId: user.id,
  userId: user.id,
  accessSubjectType: "user",
  accessSubjectId: user.id,
  status,
  errorCode: status === "failed" ? "smtp_refused" : null,
  inputMeta: { type: "object", keys: ["to", "subject"], omittedKeys: 0 },
  outputMeta: null,
  idempotencyKey: null,
  replayed: false,
  startedAt: "2026-11-26T09:00:00.000Z",
  completedAt: "2026-11-26T09:00:06.000Z",
  durationMs: 6_000,
  ...overrides,
});

test("capabilities: the calls of the window with their figures, the open request beside them, and the busiest apps", async () => {
  const summary = {
    executions: 12_345,
    failed: 7,
    denied: 2,
    destructive: 1,
    avgDurationMs: 820,
    p95DurationMs: 6_400,
    apps: [{ id: "mail", executions: 12_000, failed: 7, denied: 2, destructive: 1 }],
    capabilities: [{ id: "mail.send", executions: 12_000, failed: 7, denied: 2, destructive: 1 }],
  };
  const list = spyOn(capabilityStore, "listCapabilityExecutions").mockImplementation(async (filter) =>
    filter?.requestId
      ? { items: [execution("2", "failed")] as never }
      : { items: [execution("1", "succeeded"), execution("2", "failed")] as never, nextCursor: "cursor-2" },
  );
  const spies = [
    stubRailSnapshot(),
    spyOn(cloud, "listApps").mockResolvedValue(APPS),
    spyOn(capabilityStore, "summarizeCapabilityExecutions").mockResolvedValue(summary),
    list,
    spyOn(server, "resolveDisplayNames").mockResolvedValue([
      { principal: { type: "user", userId: user.id }, displayName: "Ada Admin" },
    ] as never),
  ];
  try {
    const response = await app().request(`/admin/observability/capabilities?status=failed&window=7d&request=request-2`, {
      headers: { "Accept-Language": "de" },
    });
    const html = await response.text();
    expect(response.status, html).toBe(200);
    const text = read(html);
    expect(text).toContain("12.345 Aufrufe");
    expect(text).toContain("mail.send");
    expect(text).toContain("smtp_refused");
    expect(text).toContain("Ada Admin");
    // the store is asked for the address's status and window, and the open request on its own
    expect(list.mock.calls.map(([filter]) => filter?.status ?? filter?.requestId)).toEqual(["failed", "request-2"]);
    expect(html).toContain("cursor=cursor-2");

    const apps = read(
      await (await app().request("/admin/observability/capabilities?tab=apps", { headers: { "Accept-Language": "de" } })).text(),
    );
    expect(apps).toContain("12.000");
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
