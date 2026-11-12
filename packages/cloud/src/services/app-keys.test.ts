import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { sql } from "../runtime/clients";
import { type getActiveAppKey, touchAppKey } from "./app-keys";

useUnitClients();
let elapsed = 0;
let clock: ReturnType<typeof spyOn<typeof performance, "now">>;
beforeEach(() => {
  elapsed += 600_000;
  clock = spyOn(performance, "now").mockImplementation(() => elapsed);
});
afterEach(() => clock.mockRestore());

const key = (keyId: string): NonNullable<Awaited<ReturnType<typeof getActiveAppKey>>> => ({
  keyId,
  appId: "inventory",
  serviceAccountId: "33333333-3333-4333-8333-333333333333",
  kind: "app_key",
  name: "Fixture",
  publicKey: "fixture",
  grants: [],
  fingerprint: "fixture",
  status: "active",
  accountStatus: "active",
  usable: true,
  createdAt: "2030-01-02T03:04:05.000Z",
  createdBy: null,
  expiresAt: null,
  revokedAt: null,
  revokedBy: null,
  lastUsedAt: null,
  connectionsAllowed: true,
  oauthIssueAllowed: false,
  installationId: "11111111-1111-4111-8111-111111111111",
  activityDue: true,
});

test("concurrent touches and stale authenticated rows issue no more than one activity statement per minute per key", async () => {
  let statements = 0;
  const db = new Proxy(sql, {
    apply() {
      statements++;
      return Promise.resolve([]);
    },
  });
  const first = key("22222222-2222-4222-8222-222222222222");
  await Promise.all(Array.from({ length: 10 }, () => touchAppKey(first, db)));
  expect(statements).toBe(1);
  elapsed += 59_999;
  await touchAppKey(first, db);
  expect(statements).toBe(1);
  await touchAppKey(key("44444444-4444-4444-8444-444444444444"), db);
  expect(statements).toBe(2);
  elapsed++;
  await touchAppKey(first, db);
  expect(statements).toBe(3);
});

test("recent database activity and inactive rows skip SQL entirely", async () => {
  const db = new Proxy(sql, {
    apply() {
      throw new Error("Unexpected activity statement");
    },
  });
  const active = key("55555555-5555-4555-8555-555555555555");
  await touchAppKey({ ...active, activityDue: false }, db);
  await touchAppKey({ ...active, status: "revoked" }, db);
  await touchAppKey({ ...active, status: "expired" }, db);
  await touchAppKey({ ...active, accountStatus: "disabled" }, db);
});

test("a failed activity statement can be retried rather than suppressing a whole minute", async () => {
  let attempts = 0;
  const db = new Proxy(sql, {
    apply() {
      if (++attempts === 1) return Promise.reject(new Error("Activity write unavailable"));
      return Promise.resolve([]);
    },
  });
  const active = key("66666666-6666-4666-8666-666666666666");
  await expect(touchAppKey(active, db)).rejects.toThrow("Activity write unavailable");
  await touchAppKey(active, db);
  await touchAppKey(active, db);
  expect(attempts).toBe(2);
});

test("a late failure cannot erase the throttle of a later activity statement", async () => {
  const pending = Promise.withResolvers<never[]>();
  let statements = 0;
  const db = new Proxy(sql, {
    apply() {
      return ++statements === 1 ? pending.promise : Promise.resolve([]);
    },
  });
  const active = key("77777777-7777-4777-8777-777777777777");
  const first = touchAppKey(active, db).catch((error: unknown) => error);
  elapsed += 60_000;
  await touchAppKey(active, db);
  pending.reject(new Error("Delayed activity failure"));
  expect(await first).toMatchObject({ message: "Delayed activity failure" });
  await touchAppKey(active, db);
  expect(statements).toBe(2);
});
