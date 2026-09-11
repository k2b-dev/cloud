import { describe, expect, test } from "bun:test";
import { defaultRailPreferences } from "../contracts/rail-preferences";
import { buildProjectedUser } from "./session/user";
import { createRailSnapshotReader, setRailCacheVersion } from "./rail-snapshot";

const user = (id: string = crypto.randomUUID(), version = "one") =>
  buildProjectedUser({ id, provider: "local", profile: "user", rail_cache_version: version });
const snapshot = (title: string) => ({
  ...defaultRailPreferences(),
  managedShortcuts: [{ id: "managed", kind: "link" as const, title, href: "/test", icon: "ti ti-link" }],
});
const memoryCache = () => {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

describe("versioned rail snapshots", () => {
  test("warm reads avoid the loader, isolate users and never serialize private versions", async () => {
    let loads = 0;
    const cache = memoryCache();
    const reader = createRailSnapshotReader(async () => {
      loads++;
      return snapshot("One");
    }, cache);
    const first = user();
    await reader(first);
    await reader(user(first.id));
    expect(loads).toBe(1);
    expect([...cache.values.keys()]).toEqual([`appglobalcache:user:${first.id}:rail:v1:one`]);
    await reader(user());
    expect(loads).toBe(2);
    expect(JSON.stringify(first)).not.toContain("rail_cache_version");
    setRailCacheVersion(first, "two");
    await reader(first);
    expect(loads).toBe(3);
  });
  test("a late old-generation refill cannot overwrite a new-generation result", async () => {
    const cache = memoryCache();
    const old = Promise.withResolvers<ReturnType<typeof snapshot>>();
    let loads = 0;
    const reader = createRailSnapshotReader(() => (++loads === 1 ? old.promise : Promise.resolve(snapshot("New"))), cache);
    const first = user();
    const pending = reader(first);
    await Promise.resolve();
    const next = user(first.id, "two");
    expect(await reader(next)).toEqual(snapshot("New"));
    old.resolve(snapshot("Old"));
    await pending;
    expect(await reader(next)).toEqual(snapshot("New"));
    expect(loads).toBe(2);
  });
  test("corrupt cache and unavailable Valkey fall back to authoritative data", async () => {
    const cache = {
      get: async () => "{",
      set: async () => {
        throw new Error("offline");
      },
    };
    const reader = createRailSnapshotReader(async () => snapshot("DB"), cache);
    expect(await reader(user())).toEqual(snapshot("DB"));
    const offline = createRailSnapshotReader(async () => snapshot("DB"), {
      ...cache,
      get: async () => {
        throw new Error("offline");
      },
    });
    expect(await offline(user())).toEqual(snapshot("DB"));
  });
});
