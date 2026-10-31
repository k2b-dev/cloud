import { expect, test } from "bun:test";
import { fixtureApps } from "./AdminApps.fixture-data";
import { type AppInput, appsHref, countStatuses, deriveApp, parseAppsQuery, sortApps } from "./model";

const app = (id: string): AppInput => fixtureApps().find((candidate) => candidate.id === id)!;

test("each app gets one status in words and its hints, most severe first", () => {
  const derived = new Map(fixtureApps().map((input) => [input.id, deriveApp(input)]));
  expect(Object.fromEntries([...derived].map(([id, entry]) => [id, entry.status]))).toEqual({
    chat: "ok",
    files: "ok",
    grids: "warn",
    inventar: "idle",
    lager: "ok",
    mail: "ok",
    notebooks: "ok",
    pulse: "error",
    spaces: "warn",
    tools: "ok",
    wiki: "error",
  });
  expect(derived.get("grids")!.hints.map((hint) => hint.kind)).toEqual(["errorRate", "failedDeliveries", "rotation"]);
  expect(derived.get("files")!.hints.map((hint) => hint.kind)).toEqual(["envStart"]);
  expect(derived.get("mail")!.hints).toEqual([]);
  expect(derived.get("wiki")!.hints.map((hint) => hint.kind)).toEqual(["providerOnly"]);
  expect(derived.get("inventar")!.hints.map((hint) => hint.kind)).toEqual(["neverStarted"]);
  expect(derived.get("notebooks")!.hints.map((hint) => hint.kind)).toEqual(["keyRevoked"]);
  expect(derived.get("pulse")!.hints.map((hint) => hint.kind)).toEqual(["startRejected", "notRunning"]);
  expect(derived.get("tools")!.hints.map((hint) => hint.kind)).toEqual(["accessUnmanaged"]);
  expect(derived.get("pulse")!.removable).toBe(true);
  expect(derived.get("mail")!.removable).toBe(false);
  expect(countStatuses([...derived.values()])).toEqual({ ok: 6, warn: 2, error: 2, idle: 1 });
});

test("a provider with many quiet requests does not hide another provider's failures", () => {
  const quiet = { provider: { appId: "a", name: "A" }, traffic: { requests: 10_000, errors: 0, avgMs: 20 }, links: [], lastSeenAt: null };
  const failing = { provider: { appId: "b", name: "B" }, traffic: { requests: 20, errors: 20, avgMs: 20 }, links: [], lastSeenAt: null };
  const entry = deriveApp({ ...app("chat"), numbers: [quiet, failing] });
  expect(entry.status).toBe("warn");
  expect(entry.hints[0]).toEqual({ kind: "errorRate", rate: 1 });
  // Too few requests say nothing about a rate.
  expect(deriveApp({ ...app("chat"), numbers: [{ ...failing, traffic: { requests: 5, errors: 5, avgMs: 1 } }] }).status).toBe("ok");
});

test("the list keeps name order, so a new hint never moves a row", () => {
  const sorted = sortApps(fixtureApps().map(deriveApp), "de").map((entry) => entry.id);
  expect(sorted).toEqual(["chat", "files", "grids", "inventar", "lager", "mail", "notebooks", "pulse", "spaces", "tools", "wiki"]);
});

test("the address keeps the open app, its column and the routes window; old names still open their place", () => {
  expect(parseAppsQuery({ app: "mail", view: "traffic", window: "7d" })).toMatchObject({ app: "mail", view: "routes", window: "7d" });
  expect(parseAppsQuery({ app: "Mail!" })).toMatchObject({ app: null, invalidApp: true });
  expect(parseAppsQuery({ view: "keys" })).toMatchObject({ app: null, view: null });
  expect(parseAppsQuery({ moved: "credentials" }).moved).toBe("credentials");
  expect(appsHref({ app: "mail", view: "routes", window: "24h" })).toBe("/admin/apps?app=mail&view=routes");
  expect(appsHref({ app: "mail", view: "routes", window: "1h" })).toBe("/admin/apps?app=mail&view=routes&window=1h");
  expect(appsHref({})).toBe("/admin/apps");
});

test("key hints come only from known facts and only for apps that can have a key", () => {
  const noKeys = { active: 0, expired: 0, revoked: 0, lastUsedAt: null, accountStatus: null };
  // Without instances that say how they started, a running app without any key started from its environment.
  expect(deriveApp({ ...app("chat"), keys: noKeys, startsWithEnv: null }).hints).toEqual([{ kind: "envStart", hasKey: false }]);
  // Core runs with its own infrastructure environment and can have no app key.
  expect(deriveApp({ ...app("chat"), id: "core", keys: noKeys, keysSupported: false }).hints).toEqual([]);
  // Unreadable facts are unknown, not "no key".
  expect(deriveApp({ ...app("chat"), keys: noKeys, keysKnown: false }).hints).toEqual([]);
  // Expired keys alone are no valid key either.
  expect(deriveApp({ ...app("chat"), keys: { ...noKeys, expired: 1 } }).hints.map((hint) => hint.kind)).toEqual(["keyRevoked"]);
});

test("the registry says which apps still start with their environment, also with a key", () => {
  const withKey = deriveApp({ ...app("chat"), startsWithEnv: true });
  expect(withKey.hints).toEqual([{ kind: "envStart", hasKey: true }]);
  // Every instance started with a key: no hint, even without any key on record.
  const noKeys = { active: 0, expired: 0, revoked: 0, lastUsedAt: null, accountStatus: null };
  expect(deriveApp({ ...app("chat"), keys: noKeys, startsWithEnv: false }).hints).toEqual([]);
  // Instances report their start without Core's facts; platform services never get the hint.
  expect(deriveApp({ ...app("chat"), keysKnown: false, startsWithEnv: true }).hints.map((hint) => hint.kind)).toEqual(["envStart"]);
  expect(deriveApp({ ...app("chat"), id: "core", keysSupported: false, startsWithEnv: true }).hints).toEqual([]);
});

test("a refused start leads, replaces what it already explains and makes the app need attention", () => {
  const at = "2026-10-30T14:27:00.000Z";
  const revoked = { active: 0, expired: 0, revoked: 1, lastUsedAt: null, accountStatus: "active" as const };
  const pulse = deriveApp(app("pulse"));
  expect(pulse.hints[0]).toEqual({ kind: "startRejected", at: "2026-10-30T14:27:00.000Z", reason: "revoked" });
  // "No valid key" says the same as the refusal of a revoked key.
  expect(pulse.hints.some((hint) => hint.kind === "keyRevoked")).toBe(false);
  // Another reason keeps the key hint: two separate problems.
  const disabled = deriveApp({ ...app("chat"), keys: revoked, startRejected: { at, reason: "disabled" } });
  expect(disabled.hints.map((hint) => hint.kind)).toEqual(["startRejected", "keyRevoked"]);
  // A running app with a refused second instance needs attention, but still runs.
  expect(disabled.status).toBe("warn");
  // A refused first start is no longer "not started yet"; its key hint would be wrong.
  const first = deriveApp({ ...app("inventar"), startRejected: { at, reason: "connections_not_permitted" } });
  expect(first.neverStarted).toBe(true);
  expect(first.status).toBe("error");
  expect(first.hints.map((hint) => hint.kind)).toEqual(["startRejected"]);
  // Core and Gateway have no app keys and no refused starts.
  expect(deriveApp({ ...app("chat"), keysSupported: false, startRejected: { at, reason: "revoked" } }).hints).toEqual([]);
});
