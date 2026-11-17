import { expect, test } from "bun:test";
import { MaintenanceBypassSchema, type MaintenanceState, MaintenanceStatusSchema } from "@k2b/cloud/contracts/maintenance";
import type { AuthContext } from "@k2b/cloud/server";
import { MAINTENANCE_BYPASS_PARAM, MAINTENANCE_BYPASS_TTL_MS, verifyMaintenanceBypassToken } from "@k2b/cloud/services/maintenance-bypass";
import type { ObservedMaintenance } from "@k2b/cloud/services/maintenance-state";
import type { MiddlewareHandler } from "hono";
import { createMaintenanceService, summarizeQuiet } from "../maintenance";
import { createAdminMaintenanceRoutes } from "./admin-maintenance";

const NOW = Date.UTC(2026, 10, 16, 13, 2);

const person = (roles: AuthContext["Variables"]["user"]["roles"]): AuthContext["Variables"]["user"] => ({
  id: "0b6f2e3c-6f0e-4d8e-9a77-3f1c2b9d4e51",
  uid: "lea",
  provider: "local",
  roles,
  profile: "user",
  givenname: "Lea",
  sn: "Muster",
  displayName: "Lea Muster",
  mail: null,
  avatarHash: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  accountExpires: null,
  lastLoginLocal: null,
  ipa: null,
});

const setup = (roles: AuthContext["Variables"]["user"]["roles"] = ["admin"]) => {
  let stored: ObservedMaintenance | null = null;
  const writes: MaintenanceState[] = [];
  const audits: string[] = [];
  const auditMetadata: Record<string, unknown>[] = [];
  const entries: unknown[] = [];
  const service = createMaintenanceService({
    store: {
      read: async () => stored,
      write: async (state) => {
        writes.push(state);
        stored = { state, updatedAt: NOW };
      },
      clear: async () => {
        stored = null;
      },
    },
    appsReady: async () => ({ ready: 9, total: 11, starting: ["files", "mail"] }),
    quietReady: async () => ({ quiet: 8, total: 9, busy: [{ id: "mail", name: "Mail", inFlight: 2, unreported: 0 }] }),
    record: async (entry) => {
      audits.push(entry.action);
      auditMetadata.push(entry.metadata ?? {});
      entries.push(entry);
    },
    now: () => NOW,
    cloudOrigin: async () => "https://cloud.musterverein.test",
  });
  // Only the authentication seam is replaced; the service still checks the role itself.
  const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
    c.set("user", person(roles));
    await next();
  };
  const routes = createAdminMaintenanceRoutes(service, authenticate);
  const call = (path: string, body?: unknown) =>
    routes.request(`http://test${path}`, {
      method: body === undefined && path === "/" ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { call, writes, audits, auditMetadata, entries, stored: () => stored };
};

test("people without the administrator role cannot read or switch maintenance, even past the route guard", async () => {
  const { call, writes, audits } = setup([]);
  expect((await call("/")).status).toBe(403);
  expect((await call("/on", {})).status).toBe(403);
  expect((await call("/until", { until: new Date(NOW + 60_000).toISOString() })).status).toBe(403);
  expect((await call("/off", {})).status).toBe(403);
  expect((await call("/bypass", {})).status).toBe(403);
  expect(writes).toEqual([]);
  expect(audits).toEqual([]);
});

test("on, until and off keep one maintenance identity and never expose the bypass key", async () => {
  const { call, writes, audits, stored } = setup();
  const until = new Date(NOW + 28 * 60_000).toISOString();
  const started = await call("/on", { message: "  Wir spielen Version 2.4 ein.  ", until });
  expect(started.status).toBe(200);
  expect(started.headers.get("cache-control")).toContain("no-store");
  const body = await started.json();
  expect(MaintenanceStatusSchema.parse(body)).toEqual({
    active: true,
    startedAt: new Date(NOW).toISOString(),
    startedBy: { id: person([]).id, label: "Lea Muster" },
    message: "Wir spielen Version 2.4 ein.",
    until,
    quiesce: false,
    apps: { ready: 9, total: 11, starting: ["files", "mail"] },
  });
  expect(JSON.stringify(body)).not.toContain(writes[0]!.bypassKey);
  expect(writes[0]!.bypassKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(writes[0]!.quiesce).toBe(false);

  // Switching on again keeps id, start and key and keeps fields it does not mention.
  const later = new Date(NOW + 58 * 60_000).toISOString();
  expect((await call("/on", { until: later })).status).toBe(200);
  expect(writes[1]).toEqual({ ...writes[0]!, until: Date.parse(later) });
  expect((await call("/on", { message: "" })).status).toBe(200);
  expect(writes[2]!.message).toBeUndefined();

  expect((await call("/until", { until: new Date(NOW + 60 * 60_000).toISOString() })).status).toBe(200);
  expect(stored()?.state.id).toBe(writes[0]!.id);

  const ended = await call("/off", {});
  expect(ended.status).toBe(200);
  expect(await ended.json()).toEqual({ active: false, apps: { ready: 9, total: 11, starting: ["files", "mail"] } });
  expect(stored()).toBeNull();
  expect(audits).toEqual(["maintenance.start", "maintenance.update", "maintenance.update", "maintenance.update", "maintenance.end"]);
});

test("a past end, an oversized message, or a new end without maintenance is refused", async () => {
  const { call, writes } = setup();
  expect((await call("/on", { until: new Date(NOW - 1).toISOString() })).status).toBe(400);
  expect((await call("/on", { message: "x".repeat(501) })).status).toBe(400);
  expect((await call("/on", { until: "14:30" })).status).toBe(400);
  expect((await call("/on", { bypassKey: "nope" })).status).toBe(400);
  expect((await call("/until", { until: new Date(NOW + 60_000).toISOString() })).status).toBe(409);
  expect(writes).toEqual([]);
});

test("stage Ruhe switches on with maintenance or later, stays until switched off, and reports quiet apps", async () => {
  const { call, writes, auditMetadata } = setup();
  const started = MaintenanceStatusSchema.parse(await (await call("/on", { quiesce: true })).json());
  expect(writes[0]!.quiesce).toBe(true);
  expect(started.quiesce).toBe(true);
  expect(started.quiet).toEqual({ quiet: 8, total: 9, busy: [{ id: "mail", name: "Mail", inFlight: 2, unreported: 0 }] });
  expect(auditMetadata[0]).toMatchObject({ quiesce: true });

  // Omitted keeps the stage; false resumes background work while maintenance stays.
  await call("/on", { message: "Datenbank wird migriert." });
  expect(writes[1]!.quiesce).toBe(true);
  const resumed = MaintenanceStatusSchema.parse(await (await call("/on", { quiesce: false })).json());
  expect(writes[2]!.quiesce).toBe(false);
  expect(writes[2]!.id).toBe(writes[0]!.id);
  expect(resumed.quiet).toBeUndefined();
  expect((await call("/on", { quiesce: "yes" })).status).toBe(400);

  // Each switch-on is a new stage Ruhe; a message change keeps the running one.
  expect(writes.map((state) => state.quiesceEpoch)).toEqual([1, 1, 1]);
  await call("/on", { quiesce: true });
  await call("/on", { message: "Fast fertig." });
  expect(writes.slice(3).map((state) => state.quiesceEpoch)).toEqual([2, 2]);
});

test("an app is quiet only when every running instance reports nothing in flight", () => {
  const apps = [
    { id: "mail", name: "Mail", instances: [{ instanceId: "m1" }, { instanceId: "m2" }] },
    { id: "files", name: "Dateien", instances: [{ instanceId: "f1" }] },
    { id: "core", name: "Core", instances: [{ instanceId: "c1" }] },
    { id: "legacy", name: "Legacy" },
  ];
  const generation = "maintenance-1:2";
  expect(
    summarizeQuiet(
      apps,
      [
        { appId: "mail", instanceId: "m1", generation, inFlight: 2 },
        { appId: "mail", instanceId: "m2", generation, inFlight: 0 },
        { appId: "core", instanceId: "c1", generation, inFlight: 0 },
        { appId: "legacy", instanceId: "l1", generation, inFlight: 0 },
        // A report under another app's instance id never counts.
        { appId: "mail", instanceId: "f1", generation, inFlight: 0 },
      ],
      generation,
    ),
  ).toEqual({
    quiet: 2,
    total: 4,
    busy: [
      { id: "files", name: "Dateien", inFlight: 0, unreported: 1 },
      { id: "mail", name: "Mail", inFlight: 2, unreported: 0 },
    ],
  });
  expect(summarizeQuiet([{ id: "legacy", name: "Legacy" }], [], generation)).toEqual({
    quiet: 0,
    total: 1,
    busy: [{ id: "legacy", name: "Legacy", inFlight: 0, unreported: 1 }],
  });
});

test("a quiet report of an earlier stage Ruhe does not count after quiesce went off and on again", () => {
  const apps = [{ id: "mail", name: "Mail", instances: [{ instanceId: "m1" }] }];
  const stale = [{ appId: "mail", instanceId: "m1", generation: "maintenance-1:1", inFlight: 0 }];
  expect(summarizeQuiet(apps, stale, "maintenance-1:1")).toEqual({ quiet: 1, total: 1, busy: [] });
  expect(summarizeQuiet(apps, stale, "maintenance-1:2")).toEqual({
    quiet: 0,
    total: 1,
    busy: [{ id: "mail", name: "Mail", inFlight: 0, unreported: 1 }],
  });
});

test("an administrator gets a bypass link for exactly this maintenance; the key and token stay out of the audit", async () => {
  const { call, writes, audits, entries } = setup();
  expect((await call("/bypass", {})).status).toBe(409);
  expect(audits).toEqual([]);

  expect((await call("/on", {})).status).toBe(200);
  const response = await call("/bypass", {});
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = MaintenanceBypassSchema.parse(await response.json());
  const expiresAt = NOW + MAINTENANCE_BYPASS_TTL_MS;
  expect(body.expiresAt).toBe(new Date(expiresAt).toISOString());
  const url = new URL(body.url);
  expect(url.origin).toBe("https://cloud.musterverein.test");
  expect(url.pathname).toBe("/");
  expect([...url.searchParams.keys()]).toEqual([MAINTENANCE_BYPASS_PARAM]);
  const token = url.searchParams.get(MAINTENANCE_BYPASS_PARAM)!;
  const state = writes[0]!;
  expect(verifyMaintenanceBypassToken(token, state, NOW)).toEqual({ subject: person([]).id, expiresAt });
  expect(verifyMaintenanceBypassToken(token, { ...state, id: "other" }, NOW)).toBeNull();
  expect(body.url).not.toContain(state.bypassKey);

  expect(audits.at(-1)).toBe("maintenance.bypass");
  expect(entries.at(-1)).toMatchObject({
    action: "maintenance.bypass",
    target: { type: "maintenance", id: state.id },
    metadata: { expiresAt: new Date(expiresAt).toISOString() },
  });
  const audited = JSON.stringify(entries);
  expect(audited).not.toContain(token);
  expect(audited).not.toContain(state.bypassKey);
});
