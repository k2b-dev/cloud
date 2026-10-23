import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { signOutBrowserSession } from "./session";
import * as offline from "./shared-text-offline";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let values = new Map<string, string>();
beforeEach(() => {
  values = new Map();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
});
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const userId = "00000000-0000-4000-8000-000000000001";

test.each([200, 409])("device cleanup and account-bound logout settle together (HTTP %s)", async (status) => {
  values.set(`cloud:user:${userId}:mail:journal`, "pending");
  values.set("cloud:user:another:mail:journal", "other person's input");
  values.set("cloud:mail:draft:legacy", "unowned legacy input");
  const steps: string[] = [];
  const cleanup = spyOn(offline, "logoutSharedTextOffline").mockImplementation(async (user) => {
    steps.push(`cleanup:${user}`);
  });
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        steps.push(`logout:${new Headers(init?.headers).get("x-cloud-logout-user")}`);
        return new Response("{}", { status });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    const pending = signOutBrowserSession(userId, "Please reload and retry");
    if (status === 200) await pending;
    else await expect(pending).rejects.toThrow("Please reload and retry");
    expect(values.has(`cloud:user:${userId}:mail:journal`)).toBe(false);
    expect(values.get(`cloud:user-epoch:${userId}`)).toBeString();
    expect(values.get("cloud:user:another:mail:journal")).toBe("other person's input");
    expect(values.get("cloud:mail:draft:legacy")).toBe("unowned legacy input");
    expect(steps).toEqual([`cleanup:${userId}`, `logout:${userId}`, ...(status === 200 ? [`cleanup:${userId}`] : [])]);
  } finally {
    cleanup.mockRestore();
    fetcher.mockRestore();
  }
});

test("missing rendered identity explicitly expects no signed-in account", async () => {
  const cleanup = spyOn(offline, "logoutSharedTextOffline");
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        expect(new Headers(init?.headers).get("x-cloud-logout-user")).toBe("none");
        return new Response("{}", { status: 409 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    await expect(signOutBrowserSession(undefined, "Reload")).rejects.toThrow("Reload");
    expect(cleanup).not.toHaveBeenCalled();
  } finally {
    cleanup.mockRestore();
    fetcher.mockRestore();
  }
});

test("a local cleanup failure still revokes the credential and retries the same account fence", async () => {
  const cleanup = spyOn(offline, "logoutSharedTextOffline")
    .mockRejectedValueOnce(new Error("Storage unavailable"))
    .mockResolvedValue(undefined);
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  try {
    await signOutBrowserSession(userId, "Retry");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(2);
  } finally {
    cleanup.mockRestore();
    fetcher.mockRestore();
  }
});
