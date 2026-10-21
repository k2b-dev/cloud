import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { SQL, sql } from "bun";
import routes from "../../api/admin-core-settings";
import { session } from "../session";
import { buildProjectedUser } from "../session/user";
import { decryptValue, encryptValue } from "./crypto";
import { SETTINGS_MAP } from "./defaults";
import { assertGeoBudgetPair } from "./geo-budget";
import * as settings from "./index";
import * as store from "./store";

const previousSecret = process.env.APP_SECRET;
const month = "geo.monthly_budget_credits",
  day = "geo.person_daily_credits";
const clients: SQL[] = [];
beforeAll(() => {
  process.env.APP_SECRET = "test-only-geo-budget";
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.APP_SECRET;
  else process.env.APP_SECRET = previousSecret;
});
beforeEach(() => {
  spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-02T03:04:05Z"));
  const user = buildProjectedUser({
    id: "00000000-0000-4000-8000-000000000003",
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
  const client = Object.assign(new SQL("postgres://localhost/unused_test"), {
    savepoint: () => {
      throw new Error("Unexpected savepoint");
    },
  });
  clients.push(client);
  const db = new Proxy(client, {
    apply(_target, _receiver, args) {
      const query: string = args[0].join("?").replace(/\s+/g, " ").trim();
      const key: unknown = query.startsWith("UPDATE settings.entries SET value = ?,") ? args[2] : args[1];
      queries.push({ query, key: typeof key === "string" ? key : undefined });
      if (query.includes("pg_advisory_xact_lock")) return Promise.resolve([]);
      if (typeof key !== "string") throw new Error("Expected a setting key");
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
  return { db, queries, rows, begin };
};
const save = (body: unknown) =>
  routes.request("/", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: "session_token=test" },
    body: JSON.stringify(body),
  });
const mutations = (queries: Array<{ query: string }>) => queries.filter(({ query }) => /^(UPDATE|INSERT|DELETE)/.test(query));

test("unrelated settings do not acquire the geo lock or read the pair", async () => {
  const tx = await transaction();
  await assertGeoBudgetPair(tx.db, { "app.name": "Cloud" }, ["geo.api_key"]);
  expect(tx.queries).toEqual([]);
});

test("standalone writes and resets reject invalid final pairs before mutation", async () => {
  for (const [key, value, reset, current] of [
    [month, 299, false, { [day]: 300 }],
    [day, 301, false, { [month]: 300 }],
    [day, 0, true, { [month]: 299 }],
    [month, 0, true, { [day]: 90001 }],
  ] as const) {
    const tx = await transaction(current);
    await expect(reset ? store.deleteKey(key) : store.writeKey(key, value)).rejects.toMatchObject({
      code: "geo_budget_invalid",
      status: 400,
    });
    expect(tx.begin).toHaveBeenCalledTimes(1);
    expect(tx.queries[0]?.query).toContain("pg_advisory_xact_lock");
    expect(mutations(tx.queries)).toEqual([]);
    tx.begin.mockRestore();
  }
});

test("standalone valid writes and resets validate and invalidate after commit", async () => {
  for (const reset of [false, true]) {
    const tx = await transaction({ [month]: 90000, [day]: 200 });
    if (reset) await store.deleteKey(day);
    else await store.writeKey(day, 500);
    expect(tx.queries.filter(({ query }) => query.includes("pg_advisory_xact_lock"))).toHaveLength(1);
    expect(tx.queries.at(-1)?.query).toContain(reset ? "DELETE" : "UPDATE settings.entries SET value = ?,");
    expect(store.invalidateSettingsCache).toHaveBeenLastCalledWith([day]);
    tx.begin.mockRestore();
  }
});

test("bulk updates validate the final pair once in either field order", async () => {
  for (const [current, updates] of [
    [
      { [month]: 90000, [day]: 300 },
      { [month]: 100, [day]: 50 },
    ],
    [
      { [month]: 90000, [day]: 300 },
      { [day]: 50, [month]: 100 },
    ],
    [
      { [month]: 100, [day]: 50 },
      { [day]: 500, [month]: 1000 },
    ],
    [
      { [month]: 100, [day]: 50 },
      { [month]: 1000, [day]: 500 },
    ],
  ] as const) {
    const tx = await transaction(current);
    expect((await save({ updates })).status).toBe(204);
    expect(tx.queries.filter(({ query }) => query.includes("pg_advisory_xact_lock"))).toHaveLength(1);
    expect(tx.queries.some(({ query }) => query.startsWith("SELECT value"))).toBeFalse();
    for (const [key, value] of Object.entries(updates!)) expect(await decryptValue(tx.rows.get(key)!)).toBe(value);
    tx.begin.mockRestore();
  }
});

test("bulk rejects invalid single updates, resets, and pairs with coded 400", async () => {
  for (const [current, body] of [
    [{ [month]: 90000, [day]: 300 }, { updates: { [month]: 299 } }],
    [{ [month]: 300 }, { updates: { [day]: 301 } }],
    [{ [month]: 100 }, { resets: [day] }],
    [{ [day]: 90001 }, { resets: [month] }],
    [{}, { updates: { [month]: 100, [day]: 101 } }],
    [{}, { updates: { [day]: 101, [month]: 100 } }],
    [{}, { updates: { [month]: 100 }, resets: [day] }],
  ] as const) {
    const tx = await transaction(current);
    const response = await save(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "geo_budget_invalid",
      errors: { [day]: expect.any(String), [month]: expect.any(String) },
    });
    expect(mutations(tx.queries)).toEqual([]);
    tx.begin.mockRestore();
  }
});

test("single reset route owns pair validation inside its transaction", async () => {
  const tx = await transaction({ [month]: 299, [day]: 50 });
  const response = await routes.request(`/${day}`, { method: "DELETE", headers: { Cookie: "session_token=test" } });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "geo_budget_invalid" });
  expect(mutations(tx.queries)).toEqual([]);
});

test("bulk repairs unreadable monthly values with replacement or reset and still validates the pair", async () => {
  for (const [body, expectedMonth, expectedDay, status] of [
    [{ updates: { [month]: 500, [day]: 400 }, replaceUnreadable: [month] }, 500, 400, 204],
    [{ updates: { [month]: 200, [day]: 400 }, replaceUnreadable: [month] }, 200, 400, 400],
    [{ updates: { [month]: 500 }, replaceUnreadable: [month] }, 500, 300, 204],
    [{ updates: { [month]: 200 }, replaceUnreadable: [month] }, 200, 300, 400],
    [{ resets: [month] }, 90000, 300, 204],
    [{ resets: [month], updates: { [day]: 90001 } }, 90000, 90001, 400],
    [{ resets: [day, month] }, 90000, 300, 204],
  ] as const) {
    const tx = await transaction({ [month]: "unreadable", [day]: 300 });
    const response = await save(body);
    expect(response.status).toBe(status);
    expect(tx.queries.some(({ query, key }) => query.startsWith("SELECT value") && key === month)).toBeFalse();
    if (status === 400) {
      expect(await response.json()).toMatchObject({ code: "geo_budget_invalid" });
      expect(mutations(tx.queries)).toEqual([]);
    } else {
      expect(tx.rows.has(month) ? await decryptValue(tx.rows.get(month)!) : SETTINGS_MAP.get(month)?.default).toBe(expectedMonth);
      expect(tx.rows.has(day) ? await decryptValue(tx.rows.get(day)!) : SETTINGS_MAP.get(day)?.default).toBe(expectedDay);
    }
    tx.begin.mockRestore();
  }
});

test("unreplaced unreadable values retain the recovery error", async () => {
  for (const [unreadable, changed] of [
    [month, day],
    [day, month],
  ] as const) {
    const tx = await transaction({ [unreadable]: "unreadable" });
    await expect(assertGeoBudgetPair(tx.db, { [changed]: 500 }, [])).rejects.toMatchObject({ code: "setting_unreadable", key: unreadable });
    const response = await save({ updates: { [changed]: 500 } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "setting_unreadable" });
    expect(mutations(tx.queries)).toEqual([]);
    const reset = await routes.request(`/${changed}`, { method: "DELETE", headers: { Cookie: "session_token=test" } });
    expect(reset.status).toBe(409);
    expect(await reset.json()).toMatchObject({ code: "setting_unreadable" });
    tx.begin.mockRestore();
  }
  const tx = await transaction({ [month]: "unreadable" });
  expect((await save({ updates: { [month]: 1000 } })).status).toBe(409);
  expect(tx.begin).not.toHaveBeenCalled();
});
