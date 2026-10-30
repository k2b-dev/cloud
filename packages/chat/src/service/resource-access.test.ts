import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { ServiceAccountSchema, UserSchema } from "@k2b/cloud/contracts";
import { redis } from "bun";
import type { ChatContext } from "./access";
import { DISCUSSION_BYTE_LIMIT, DISCUSSION_CALL_LIMIT, DiscussionRead } from "./discussion-read";
import { mockDiscussionCatalog, providerApp } from "./discussions.test-fixture";
import {
  accessKey,
  cachedResource,
  contextPrincipal,
  READER_CONCURRENCY,
  type ResourceReaderDependencies,
  readContainers,
  readerBatch,
  readResource,
} from "./resource-access";

const originalOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
const now = Date.parse("2026-10-29T12:00:00Z");
const user = UserSchema.parse({
  id: "12345678-1234-4234-8234-123456789012",
  uid: "lea",
  provider: "local",
  profile: "user",
  roles: ["user"],
  givenname: "Lea",
  sn: "Example",
  displayName: "Lea",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const context = (): ChatContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  caller: { cookie: "test-session" },
});
const ref = { type: "inventory.collection", id: "12345678-1234-4234-8234-123456789099" };
const item = { type: "inventory.item", id: "12345678-1234-4234-8234-123456789088" };
const envelope = (permission = "write", contained = false) => ({
  data: {
    view: {
      title: "Inventory",
      permission,
      context: "Warehouse",
      ...(contained ? { container: { ref, title: "Inventory" }, status: "Available", done: false } : {}),
    },
  },
  links: [{ rel: "open", href: "/app/inventory/resource" }],
});
const cache = new Map<string, { value: string; until: number }>();
let catalog: ReturnType<typeof mockDiscussionCatalog>, get: ReturnType<typeof spyOn>, set: ReturnType<typeof spyOn>;
beforeEach(() => {
  setSystemTime(new Date(now));
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.test";
  cache.clear();
  catalog = mockDiscussionCatalog([providerApp("inventory")]);
  get = spyOn(redis, "get").mockImplementation(async (key) => {
    if (typeof key !== "string") throw new Error("String key expected");
    const entry = cache.get(key);
    return entry && entry.until > Date.now() ? entry.value : null;
  });
  set = spyOn(redis, "set").mockImplementation(async (...args: unknown[]) => {
    const [key, value, ...options] = args;
    if (typeof key !== "string" || typeof value !== "string") throw new Error("String values expected");
    expect(options).toEqual(["EX", 60]);
    cache.set(key, { value, until: Date.now() + 60_000 });
    return "OK" as const;
  });
});
afterEach(() => {
  catalog.mockRestore();
  get.mockRestore();
  set.mockRestore();
  setSystemTime();
  if (originalOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  else process.env.CLOUD_CORE_INTERNAL_ORIGIN = originalOrigin;
});

test("reads standard views from catalog roles with opaque IDs and no domain parsing", async () => {
  const c = context();
  const calls: string[] = [];
  const dependencies: ResourceReaderDependencies = {
    invoke: async (app, capability, input, caller) => {
      expect(app).toBe("inventory");
      expect(caller.cookie).toBe("test-session");
      expect(input.id).toBe(capability === "item.read" ? item.id : ref.id);
      calls.push(capability);
      return envelope("write", capability === "item.read");
    },
  };
  expect(await readResource(c, item, dependencies)).toMatchObject({
    title: "Inventory",
    context: "Warehouse",
    permission: "write",
    container: { ref, title: "Inventory" },
    icon: "ti ti-package",
    color: "amber",
  });
  expect(calls).toEqual(["item.read"]);
  expect(await readResource(c, { ...ref, type: "unknown.collection" }, dependencies)).toBeNull();
  expect(await readResource(c, ref, { invoke: async () => envelope("manage") })).toBeNull();
  expect(await readResource(context(), item, { invoke: async () => envelope("read") })).toMatchObject({ permission: "write" }); // existing valid cache
  cache.clear();
  expect(await readResource(context(), item, { invoke: async () => envelope("read") })).toBeNull();
});

test("separates localized views and locale-free live authority and expires both", async () => {
  const c = context();
  const dependencies: ResourceReaderDependencies = { invoke: async () => envelope() };
  await readResource({ ...c, locale: "de" }, ref, dependencies);
  expect(await cachedResource(contextPrincipal(c), ref)).toMatchObject({ permission: "write" });
  expect(accessKey(contextPrincipal(c), ref, "de")).not.toBe(accessKey(contextPrincipal(c), ref, "en"));
  let calls = 0;
  await readResource({ ...context(), locale: "en" }, ref, {
    invoke: async () => {
      calls++;
      return envelope();
    },
  });
  expect(calls).toBe(1);
  setSystemTime(new Date(now + 60_000));
  expect(await cachedResource(contextPrincipal(c), ref)).toBeNull();
  expect(await readResource({ ...context(), locale: "de" }, ref, { invoke: async () => null })).toBeNull();
});

test("nested queries bypass HTTP authorization and invoke the declared reader", async () => {
  const c = context();
  await readResource(c, ref, { invoke: async () => envelope() });
  const capabilityQuery: NonNullable<ChatContext["capabilityQuery"]> = async (request) => {
    expect(request).toMatchObject({ appId: "inventory", capabilityId: "collection.read", input: { id: ref.id } });
    return { ok: false, error: { code: "FORBIDDEN", message: "Denied", status: 403 } };
  };
  expect(await readResource({ ...context(), capabilityQuery }, ref)).toBeNull();
  expect(await cachedResource(contextPrincipal(c), ref)).toMatchObject({ permission: "write" });
});

test("lists via the role and validates returned container types and progress", async () => {
  const dependencies: ResourceReaderDependencies = {
    invoke: async (app, capability, input) => {
      expect([app, capability, input]).toEqual(["inventory", "collection.containers", { limit: 100, cursor: "before", query: "Ware" }]);
      return { data: { items: [{ ref, title: "Warehouse" }], next: "after" } };
    },
  };
  expect(await readContainers(context(), ref.type, "before", dependencies, "Ware")).toMatchObject({
    items: [{ ref, name: "Warehouse", icon: "ti ti-box", color: "blue" }],
    nextCursor: "after",
  });
  await expect(
    readContainers(context(), ref.type, undefined, {
      invoke: async () => ({ data: { items: [{ ref: item, title: "Wrong" }], next: null } }),
    }),
  ).rejects.toThrow();
  expect(
    await readContainers(context(), ref.type, "", {
      invoke: async () => {
        throw new Error("Exhausted");
      },
    }),
  ).toEqual({ items: [], nextCursor: null });
});

test("one shared call and byte budget includes discovery and honors cancellation", async () => {
  const session = new DiscussionRead(context().caller!);
  await session.catalog();
  expect(session.remaining).toBe(DISCUSSION_CALL_LIMIT - 1);
  for (let i = 1; i < DISCUSSION_CALL_LIMIT; i++) await session.page(async () => null);
  await expect(session.page(async () => null)).rejects.toThrow("DISCUSSION_CALL_BUDGET");
  const bytes = new DiscussionRead(context().caller!);
  await expect(bytes.page(async () => "x".repeat(DISCUSSION_BYTE_LIMIT))).rejects.toThrow("DISCUSSION_BYTE_BUDGET");
  const controller = new AbortController();
  const cancelled = new DiscussionRead({ signal: controller.signal });
  const pending = cancelled.page(async () => new Promise<never>(() => {}));
  controller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  const expired = new DiscussionRead({});
  setSystemTime(new Date(now + 10_001));
  await expect(expired.page(async () => null)).rejects.toThrow("DISCUSSION_DEADLINE");
});

test("reader batches never exceed the common concurrency limit", async () => {
  let active = 0,
    peak = 0;
  await readerBatch(
    Array.from({ length: 20 }, (_, i) => i),
    async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
    },
  );
  expect(peak).toBe(READER_CONCURRENCY);
});

test("reader and cache outages, missing credentials and cancellation fail closed", async () => {
  const failure: ResourceReaderDependencies = {
    invoke: async () => {
      throw new Error("offline");
    },
  };
  expect(await readResource(context(), ref, failure)).toBeNull();
  expect(await readResource({ ...context(), caller: undefined }, ref, failure)).toBeNull();
  expect(await readResource({ ...context(), caller: { signal: AbortSignal.abort() } }, ref, failure)).toBeNull();
  get.mockRejectedValue(new Error("Valkey offline"));
  expect(await readResource(context(), ref, { invoke: async () => envelope() })).toBeNull();
  expect(await cachedResource(contextPrincipal(context()), ref)).toBeNull();
  get.mockResolvedValue(null);
  set.mockRejectedValue(new Error("Valkey offline"));
  expect(await readResource(context(), ref, { invoke: async () => envelope() })).toBeNull();
});

test("credential scopes partition HTTP and live decisions without storing credentials", async () => {
  const serviceAccount = ServiceAccountSchema.parse({
    id: "12345678-1234-4234-8234-123456789013",
    name: "Agent",
    kind: "agent",
    status: "active",
    delegatedUserId: null,
    appId: null,
    resourceType: null,
    resourceId: null,
    createdBy: null,
    createdAt: "2026-10-01T00:00:00Z",
  });
  const agent = (scopes: string[]): ChatContext => ({
    actor: { kind: "service_account", serviceAccount, scopes, delegatedUser: null },
    accessSubject: { type: "service_account", serviceAccountId: serviceAccount.id },
    caller: { authorization: "Bearer test-agent" },
  });
  const read = agent(["read"]),
    write = agent(["write", "read"]);
  expect(contextPrincipal(read)).not.toBe(contextPrincipal(write));
  expect(contextPrincipal(write)).toBe(contextPrincipal(agent(["read", "write", "read"])));
  expect(accessKey(contextPrincipal(read), ref)).not.toContain("test-agent");
  await readResource(write, ref, { invoke: async () => envelope() });
  expect(await readResource(read, ref, { invoke: async () => null })).toBeNull();
  expect(await cachedResource(contextPrincipal(read), ref)).toBeNull();
  expect(await cachedResource(contextPrincipal(write), ref)).toMatchObject({ permission: "write" });
});

test("distinguishes explicit denials from unavailable or malformed readers", async () => {
  let unavailable = 0;
  const mark = () => {
    unavailable++;
  };
  expect(
    await readResource(
      context(),
      ref,
      {
        invoke: async () => {
          throw new Error("offline");
        },
      },
      mark,
    ),
  ).toBeNull();
  expect(unavailable).toBe(1);
  expect(await readResource(context(), ref, { invoke: async () => ({ data: {} }) }, mark)).toBeNull();
  expect(unavailable).toBe(2);
  expect(await readResource(context(), ref, { invoke: async () => null }, mark)).toBeNull();
  expect(unavailable).toBe(2);
  cache.clear();
  await expect(
    readContainers(context(), ref.type, undefined, {
      invoke: async () => {
        throw new Error("offline");
      },
    }),
  ).rejects.toThrow();
  await expect(readContainers(context(), ref.type, undefined, { invoke: async () => ({ data: {} }) })).rejects.toThrow();
  expect(await readContainers(context(), ref.type, undefined, { invoke: async () => null })).toEqual({ items: [], nextCursor: null });
});

test("one session limits nested reader batches to six in-flight capability calls", async () => {
  const session = new DiscussionRead({});
  let active = 0,
    peak = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const full = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = readerBatch([0, 1, 2, 3, 4, 5], async () =>
    readerBatch([0, 1, 2, 3, 4, 5], async () =>
      session.page(async () => {
        active++;
        peak = Math.max(peak, active);
        if (active === 6) started();
        await gate;
        active--;
      }),
    ),
  );
  await full;
  expect(active).toBe(6);
  release();
  await pending;
  expect(peak).toBe(6);
});

test("cancels queued capability calls before they start", async () => {
  const controller = new AbortController(),
    session = new DiscussionRead({ signal: controller.signal });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const full = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const run = () =>
    session.page(async () => {
      if (++calls === 6) started();
      await gate;
    });
  const active = Array.from({ length: 6 }, run);
  await full;
  const queued = run();
  controller.abort(new Error("cancelled"));
  const settled = await Promise.allSettled([...active, queued]);
  release();
  expect(settled.every((result) => result.status === "rejected")).toBeTrue();
  expect(calls).toBe(6);
});

test("deduplicates cold concurrent container reads and spends no calls on cache hits", async () => {
  const c = context();
  let calls = 0;
  const dependencies: ResourceReaderDependencies = {
    invoke: async () => {
      calls++;
      return envelope();
    },
  };
  const resources = await readerBatch(
    Array.from({ length: 100 }, () => ref),
    (ref) => readResource(c, ref, dependencies),
  );
  expect(resources.every((resource) => resource?.title === "Inventory")).toBeTrue();
  expect(calls).toBe(1);
  const { discussionRead } = await import("./discussion-read");
  expect(discussionRead(c).remaining).toBe(DISCUSSION_CALL_LIMIT - 2);
});

test("readers without open links remain readable and manifest icons are constrained", async () => {
  catalog.mockRestore();
  const app = providerApp("inventory");
  app.manifest.types[0]!.icon = "ti ti-box arbitrary-class";
  catalog = mockDiscussionCatalog([app]);
  const resource = await readResource(context(), ref, { invoke: async () => ({ data: envelope().data }) });
  expect(resource).toMatchObject({ title: "Inventory", icon: "ti ti-messages" });
  expect(resource?.href).toBeUndefined();
});
