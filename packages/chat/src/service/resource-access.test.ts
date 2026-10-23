import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ServiceAccountSchema, UserSchema } from "@k2b/cloud/contracts";
import { redis } from "bun";
import type { ChatContext } from "./access";
import {
  accessKey,
  cachedResource,
  contextPrincipal,
  type ResourceReaderDependencies,
  readContainers,
  readerBatch,
  readResource,
} from "./resource-access";

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
const context: ChatContext = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  caller: { cookie: "test-session" },
};
const ref = { type: "spaces.space", id: "abcdef" };
const cache = new Map<string, { value: string; until: number }>();
let now = 0;
let get: ReturnType<typeof spyOn>, set: ReturnType<typeof spyOn>;
beforeEach(() => {
  now = 0;
  cache.clear();
  get = spyOn(redis, "get").mockImplementation(async (key) => {
    if (typeof key !== "string") throw new Error("Expected a string cache key");
    const item = cache.get(key);
    return item && item.until > now ? item.value : null;
  });
  set = spyOn(redis, "set").mockImplementation(async (...args: unknown[]) => {
    const [key, value, ...options] = args;
    if (typeof key !== "string" || typeof value !== "string") throw new Error("Expected string cache values");
    expect(options).toEqual(["EX", 60]);
    cache.set(key, { value, until: now + 60_000 });
    return "OK" as const;
  });
});
afterEach(() => {
  get.mockRestore();
  set.mockRestore();
});

test("uses the caller, maps permissions, and rejects malformed reader responses", async () => {
  for (const permission of ["read", "write", "manage", "admin", "none"] as const) {
    cache.clear();
    const dependencies: ResourceReaderDependencies = {
      invoke: async (app, capability, input, caller) => {
        expect([app, capability, input, caller]).toEqual(["spaces", "space.read", { id: ref.id }, context.caller!]);
        return { data: { id: ref.id, name: "Project", permission }, links: [{ rel: "open", href: "/app/spaces/abcdef" }] };
      },
    };
    expect((await readResource(context, ref, dependencies))?.permission ?? null).toBe(
      permission === "none" ? null : permission === "manage" ? "admin" : permission,
    );
  }
  cache.clear();
  expect(
    await readResource(context, ref, {
      invoke: async () => ({ data: { id: "other", name: "Other", permission: "admin" }, links: [{ rel: "open", href: "/other" }] }),
    }),
  ).toBeNull();
});

test("Valkey is the only decision cache; expiration revokes HTTP and live access", async () => {
  let readable = true,
    calls = 0;
  const dependencies: ResourceReaderDependencies = {
    invoke: async () => {
      calls++;
      return readable
        ? { data: { id: ref.id, name: "Project", permission: "read" }, links: [{ rel: "open", href: "/app/spaces/abcdef" }] }
        : null;
    },
  };
  expect((await readResource(context, ref, dependencies))?.permission).toBe("read");
  expect(calls).toBe(1);
  readable = false;
  now = 59_999;
  expect((await readResource(context, ref, dependencies))?.permission).toBe("read");
  expect((await cachedResource(contextPrincipal(context), ref))?.permission).toBe("read");
  expect(calls).toBe(1);
  now = 60_000;
  expect(await cachedResource(contextPrincipal(context), ref)).toBeNull();
  expect(await readResource(context, ref, dependencies)).toBeNull();
  expect(calls).toBe(2);
  expect(await readResource(context, ref, dependencies)).toBeNull();
  expect(calls).toBe(2);
});

test("app failure, cache failure, missing credentials and canceled reads fail closed", async () => {
  const failure: ResourceReaderDependencies = {
    invoke: async () => {
      throw new Error("offline");
    },
  };
  expect(await readResource(context, ref, failure)).toBeNull();
  expect(await readResource({ ...context, caller: undefined }, ref, failure)).toBeNull();
  expect(await readResource({ ...context, caller: { signal: AbortSignal.abort() } }, ref, failure)).toBeNull();
  get.mockRejectedValue(new Error("Valkey offline"));
  expect(await readResource(context, ref, failure)).toBeNull();
  expect(await cachedResource(contextPrincipal(context), ref)).toBeNull();
});

test("separates credential scope decisions and accepts notes only with a reader-provided notebook", async () => {
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
  expect(contextPrincipal(agent(["read"]))).not.toBe(contextPrincipal(agent(["admin"])));
  expect(accessKey(contextPrincipal(context), ref)).not.toContain("test-session");
  const note = { type: "notebooks.note", id: "note01" };
  expect(
    await readResource(context, note, {
      invoke: async () => ({ data: { id: note.id, title: "Note" }, links: [{ rel: "open", href: "/note" }] }),
    }),
  ).toBeNull();
  cache.clear();
  expect(
    await readResource(context, note, {
      invoke: async () => ({ data: { id: note.id, title: "Note", notebookId: "book01" }, links: [{ rel: "open", href: "/note" }] }),
    }),
  ).toMatchObject({ kind: "note", container: { type: "notebooks.notebook", id: "book01" }, status: null, done: false });
});

test("batches no more than eight readers and preserves input order", async () => {
  let active = 0,
    peak = 0;
  const values = Array.from({ length: 25 }, (_, i) => i);
  const result = await readerBatch(values, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return value;
  });
  expect(result).toEqual(values);
  expect(peak).toBe(8);
});

test("container discovery distinguishes provider failure, malformed data, denial and empty pages", async () => {
  await expect(
    readContainers(context, "spaces.space", undefined, {
      invoke: async () => {
        throw new Error("offline");
      },
    }),
  ).rejects.toThrow();
  await expect(readContainers(context, "spaces.space", undefined, { invoke: async () => ({ data: {} }) })).rejects.toThrow();
  expect(await readContainers(context, "spaces.space", undefined, { invoke: async () => null })).toEqual({ items: [], nextCursor: null });
  expect(await readContainers(context, "spaces.space", undefined, { invoke: async () => ({ data: [] }) })).toEqual({
    items: [],
    nextCursor: null,
  });
});

test("item readers project status names, due dates, assignee names and event timing without identifier fallbacks", async () => {
  const item = { type: "spaces.item", id: "Item01" };
  const deadline = "2026-11-01T09:00:00.000Z";
  let kind: "task" | "event" = "task";
  const dependencies: ResourceReaderDependencies = {
    invoke: async (_app, capability) =>
      capability === "space.read"
        ? {
            data: { id: "Space1", name: "Space", permission: "read", columns: [{ id: "Col001", name: "In progress" }] },
            links: [{ rel: "open", href: "/space" }],
          }
        : {
            data: {
              id: item.id,
              title: "Prepare",
              kind,
              spaceId: "Space1",
              columnId: "Col001",
              completedAt: null,
              deadline,
              deadlineAllDay: true,
              assignees: [{ id: "opaque-person-id", displayName: "Nora" }],
              startsAt: deadline,
              endsAt: "2026-11-01T10:00:00.000Z",
              allDay: false,
            },
            links: [{ rel: "open", href: "/item" }],
          },
  };
  expect(await readResource(context, item, dependencies)).toMatchObject({
    status: "In progress",
    deadline,
    deadlineAllDay: true,
    assignees: ["Nora"],
  });
  cache.clear();
  kind = "event";
  expect(await readResource(context, item, dependencies)).toMatchObject({
    startsAt: deadline,
    endsAt: "2026-11-01T10:00:00.000Z",
    allDay: false,
  });
  cache.clear();
  const noLabel: ResourceReaderDependencies = {
    invoke: async (app, capability, input, caller) =>
      capability === "space.read"
        ? { data: { id: "Space1", name: "Space", permission: "read" }, links: [{ rel: "open", href: "/space" }] }
        : dependencies.invoke(app, capability, input, caller),
  };
  expect((await readResource(context, item, noLabel))?.status).toBeNull();
});
