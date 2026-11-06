import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { useUnitClients } from "../../../../../scripts/fixtures/unit-clients";
import routes from "../../api/admin-core-settings";
import { sql } from "../../runtime/clients";
import { stubConnections } from "../../runtime/connections.test-fixture";
import { audit } from "../audit";
import { session } from "../session";
import { buildProjectedUser } from "../session/user";
import { decryptValue, encryptValue } from "./crypto";
import { SETTINGS_MAP } from "./defaults";
import * as settings from "./index";
import * as store from "./store";

useUnitClients();

let secretStub: ReturnType<typeof stubConnections> | undefined;
const month = "geo.monthly_budget_credits",
  day = "geo.person_daily_credits";
const clients: SQL[] = [];
const actorId = "00000000-0000-4000-8000-000000000003";

afterAll(() => {
  secretStub?.mockRestore();
});
beforeEach(() => {
  spyOn(audit, "record").mockResolvedValue();
  secretStub = stubConnections({ appSecret: { current: "test-only-geo-budget" } });
  spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-02T03:04:05Z"));
  const user = buildProjectedUser({
    id: actorId,
    provider: "local",
    profile: "user",
    effective_admin: true,
  });
  spyOn(session, "authenticateRequest").mockResolvedValue({
    user,
    data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2026-01-03T03:04:05.000Z" },
  });
  spyOn(store, "invalidateSettingsCache").mockResolvedValue();
});
afterEach(async () => {
  mock.restore();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

// Run real validation, encryption and store mutations against a scripted SQL transaction, never a server.
const transaction = async (values: Record<string, number | "unreadable"> = {}) => {
  const rows = new Map<string, string>();
  for (const [key, value] of Object.entries(values))
    rows.set(key, value === "unreadable" ? "broken-ciphertext" : await encryptValue(value));
  const queries: Array<{ query: string; key?: string }> = [];
  const updatedBy = new Map<string, string>();
  const client = Object.assign(new SQL("postgres://localhost/unused_test"), {
    savepoint: () => {
      throw new Error("Unexpected savepoint");
    },
  });
  clients.push(client);
  const db = new Proxy(client, {
    apply(_target, _receiver, args) {
      const query: string = args[0].join("?").replace(/\s+/g, " ").trim();
      const attribution = query === "UPDATE settings.entries SET updated_by=?::uuid WHERE key=?";
      const key: unknown = query.startsWith("UPDATE settings.entries SET value = ?,") || attribution ? args[2] : args[1];
      queries.push({ query, key: typeof key === "string" ? key : undefined });
      if (query.includes("pg_advisory_xact_lock")) return Promise.resolve([]);
      if (typeof key !== "string") throw new Error("Expected a setting key");
      if (attribution) {
        if (typeof args[1] !== "string" || !rows.has(key)) throw new Error("Expected an actor and a saved setting");
        updatedBy.set(key, args[1]);
        return Promise.resolve([]);
      }
      const value = rows.get(key);
      if (query.startsWith("SELECT value") || query.startsWith("UPDATE settings.entries SET value = value"))
        return Promise.resolve(value === undefined ? [] : [{ value }]);
      if (query.startsWith("INSERT")) {
        if (rows.has(key)) return Promise.resolve([]);
        rows.set(key, args[2]);
        return Promise.resolve([{ key }]);
      }
      if (query.startsWith("UPDATE settings.entries SET value = ?,")) rows.set(key, args[1]);
      else if (query.startsWith("DELETE")) rows.delete(key);
      else throw new Error(`Unexpected query: ${query}`);
      return Promise.resolve([]);
    },
  });
  const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    await run(db);
  });
  spyOn(settings, "readStates").mockImplementation(
    async (keys) =>
      new Map<string, store.SettingRead>(
        await Promise.all(
          keys.map(async (key) => {
            const fallback = SETTINGS_MAP.get(key)?.default;
            const row = rows.get(key);
            if (!row) return [key, { stored: "none" as const, value: fallback }] as const;
            try {
              return [key, { stored: "readable" as const, value: await decryptValue(row) }] as const;
            } catch {
              return [key, { stored: "unreadable" as const, value: fallback }] as const;
            }
          }),
        ),
      ),
  );
  return { db, queries, rows, begin, updatedBy };
};
const save = (body: unknown) =>
  routes.request("/", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: "session_token=test" },
    body: JSON.stringify(body),
  });
const mutations = (queries: Array<{ query: string }>) => queries.filter(({ query }) => /^(UPDATE|INSERT|DELETE)/.test(query));

test("monthly budgets are independent of obsolete stored daily values", async () => {
  const tx = await transaction({ [day]: "unreadable" });
  expect((await save({ updates: { [month]: 0 } })).status).toBe(204);
  expect(await decryptValue(tx.rows.get(month)!)).toBe(0);
  expect(tx.rows.get(day)).toBe("broken-ciphertext");
  expect(tx.queries.some(({ key }) => key === day)).toBe(false);
});
test("the removed daily setting is not writable", async () => {
  const tx = await transaction();
  expect((await save({ updates: { [day]: 1 } })).status).toBe(400);
  expect(mutations(tx.queries)).toEqual([]);
});

test("the generic settings route refuses the Geoapify key, which only the verifying geo route writes", async () => {
  const tx = await transaction();
  for (const body of [{ updates: { "geo.api_key": "unverified" } }, { resets: ["geo.api_key"] }, { "geo.api_key": "unverified" }]) {
    const response = await save(body);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(Object.keys(json.errors)).toEqual(["geo.api_key"]);
    expect(JSON.stringify(json)).not.toContain("unverified");
  }
  const reset = await routes.request("/geo.api_key", { method: "DELETE", headers: { Cookie: "session_token=test" } });
  expect(reset.status).toBe(400);
  expect(tx.begin).not.toHaveBeenCalled();
  expect(mutations(tx.queries)).toEqual([]);
});
