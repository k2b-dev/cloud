import { beforeEach, expect, mock, test } from "bun:test";
import { CAPABILITY_MAX_RESULT_BYTES, type CapabilityExecutionContext } from "@k2b/cloud/contracts";
import * as cloudServer from "@k2b/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { hc } from "hono/client";
import { testActor, testCall } from "../test/files-call";
import type { ActivityChain, ActivityEntry, ActivityInput, ActivityPage, ShareAccessCounts, ShareAccessInput } from "./activity-contracts";
import { ActivityBatchContextSchema } from "./activity-contracts";
import { ActivityChainSchema, ActivityEntrySchema, ActivityPageSchema, ActivitySideSchema } from "./activity-transport";
import { capabilityCall } from "./files-call";
import type { ActivityReadCall } from "./service/activity-reader";
import { FilesError } from "./service/errors";

const pass: MiddlewareHandler = async (_c, next) => next();
mock.module("@k2b/cloud/server", () => ({ ...cloudServer, auth: { ...cloudServer.auth, requireRole: () => pass }, rateLimit: () => pass }));
const id = "10000000-0000-4000-8000-000000000002";
const row: ActivityEntry = {
  id,
  action: "item.move",
  state: "done",
  time: "2026-10-20T12:00:00.000Z",
  startedAt: "2026-10-20T12:00:00.000Z",
  finishedAt: "2026-10-20T12:00:00.000Z",
  actor: { kind: "user", userId: null, name: null },
  via: "api",
  before: { visibility: "disappearance", name: "Old", path: "Docs/Old", directory: null, publicBaseId: null },
  after: { visibility: "hidden" },
  batchId: null,
};
let page: ActivityPage;
const chain: ActivityChain = {
  sourceId: id,
  hops: [{ activityId: id, time: row.time, actor: row.actor, via: row.via, before: row.before, after: row.after }],
  endpoint: null,
  certainty: "unavailable",
  historyComplete: false,
  truncated: false,
};
const accessCounts: ShareAccessCounts = {
  pageNetworks: null,
  from: "2026-10-01",
  to: "2026-10-20",
  timeline: {
    items: [
      {
        date: row.time,
        granularity: "hour",
        pages: 3,
        pageNetworks: 1,
        downloads: 2,
        passwordFailed: 1,
        knownNetworks: 3,
        overflow: false,
      },
      {
        date: "2026-10-19T00:00:00.000Z",
        granularity: "day",
        pages: 0,
        pageNetworks: null,
        downloads: 0,
        passwordFailed: 0,
        knownNetworks: null,
        overflow: false,
      },
    ],
    next: null,
  },
  pages: 3,
  downloads: 2,
  passwordFailed: 1,
  networks: {
    known: 2,
    incomplete: true,
    overflow: true,
    items: [{ network: "192.0.2.0/24", pages: 3, downloads: 2, passwordFailed: 1, firstSeen: row.time, lastSeen: row.time }],
    next: "192.0.2.0/24",
    rolledUp: true,
  },
};
let failure: Error | null = null;
const calls: { method: string; call: ActivityReadCall; input: unknown }[] = [];
function record(method: string, call: ActivityReadCall, input: unknown) {
  calls.push({ method, call, input });
  if (failure) throw failure;
}
mock.module("./service", () => ({
  FilesError,
  EDITOR_DOCUMENT_LIMIT: 256 * 1024 * 1024,
  filesService: {
    activity: async (call: ActivityReadCall, input: ActivityInput) => {
      record("activity", call, input);
      return page;
    },
    activityForEntry: async (call: ActivityReadCall, id: string, input: Omit<ActivityInput, "baseId" | "itemId" | "path">) => {
      record("activityForEntry", call, { id, ...input });
      return page;
    },
    movementChain: async (call: ActivityReadCall, input: { activityId: string }) => {
      record("movementChain", call, input);
      return chain;
    },
    activityBatchContext: async (call: ActivityReadCall, input: { activityId: string }) => {
      record("activityBatchContext", call, input);
      return { visibleCount: 42, complete: true };
    },
    shareAccess: async (call: ActivityReadCall, input: ShareAccessInput) => {
      record("shareAccess", call, input);
      return accessCounts;
    },
    adminActivityBases: async (call: ActivityReadCall, input: unknown) => {
      record("adminActivityBases", call, input);
      return { items: [{ id: `cloud:users:${id}`, name: "Current user", kind: "users" }], next: null };
    },
    baseNames: async (call: ActivityReadCall) => {
      record("baseNames", call, {});
      return [{ id: `cloud:users:${testActor.kind === "user" ? testActor.user.id : ""}`, name: "alice", kind: "users" }];
    },
  },
}));
const { default: routes } = await import("./api");
const { filesCapabilities } = await import("./capabilities");
const actor = {
  ...testActor,
  delegation: {
    kind: "invocation" as const,
    callingAppId: "assistant",
    credentialKind: "session" as const,
    invocationId: id,
    requestId: "delegate-request",
  },
};
const app = new Hono<cloudServer.AuthContext>()
  .use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("accessSubject", testCall(actor).accessSubject);
    c.set("credentialKind", "invocation");
    await next();
  })
  .route("/api/filesv2", routes);
const client = hc<typeof app>("http://cloud.test", {
  fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => app.request(input, init),
});
const context: CapabilityExecutionContext = {
  actor,
  accessSubject: testCall(actor).accessSubject,
  origin: "assistant",
  requestId: "cap-request",
  locale: "de",
  user: actor.kind === "user" ? actor.user : null,
  signal: new AbortController().signal,
};
beforeEach(() => {
  page = {
    items: [row],
    next: "opaque-next",
    visibleCount: 1,
    batches: [],
    exhausted: false,
    scanLimitReached: false,
    searchLimitReached: false,
  };
  failure = null;
  calls.length = 0;
});

test("typed HTTP client forwards all history filters and preserves the projected page", async () => {
  const query = {
    baseId: "cloud:users:me",
    path: "Old/file.txt",
    scope: "folder" as const,
    q: "Old/file.txt",
    actor: id,
    action: "item.move" as const,
    from: row.time,
    to: row.time,
    cursor: "opaque",
    limit: "7",
  };
  const response = await client.api.filesv2.activity.$get({ query });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(page);
  expect(calls).toEqual([
    {
      method: "activity",
      call: {
        ...testCall(actor),
        requestAbort: expect.any(AbortSignal),
        via: "app:assistant",
        requestId: "delegate-request",
        invocationId: id,
        callingApp: "assistant",
      },
      input: { ...query, limit: 7 },
    },
  ]);
});
test("default and invalid reader-owned page limits are validated before the service", async () => {
  const response = await client.api.filesv2.activity.$get({ query: {} });
  expect(response.status).toBe(200);
  expect(calls[0]?.input).toEqual({ scope: "item", limit: 50 });
  for (const limit of ["0", "51", "1.5", "no"]) {
    calls.length = 0;
    expect(Number((await client.api.filesv2.activity.$get({ query: { limit } })).status)).toBe(400);
    expect(calls).toHaveLength(0);
  }
});
test("typed batch endpoint forwards request identity/cancellation and returns only count/completeness", async () => {
  const response = await client.api.filesv2.activity[":activityId"].batch.$get({ param: { activityId: id } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ visibleCount: 42, complete: true });
  expect(calls).toEqual([
    {
      method: "activityBatchContext",
      call: {
        ...testCall(actor),
        requestAbort: expect.any(AbortSignal),
        via: "app:assistant",
        requestId: "delegate-request",
        invocationId: id,
        callingApp: "assistant",
      },
      input: { activityId: id },
    },
  ]);
  expect(response.headers.get("cache-control")).toContain("no-transform");
  for (const status of [404, 503] as const) {
    failure = new FilesError(status === 404 ? "not_found" : "unavailable", status);
    expect(Number((await client.api.filesv2.activity[":activityId"].batch.$get({ param: { activityId: id } })).status)).toBe(status);
  }
  calls.length = 0;
  expect(Number((await client.api.filesv2.activity[":activityId"].batch.$get({ param: { activityId: "invalid" } })).status)).toBe(400);
  expect(calls).toEqual([]);
});

test("batch schema rejects totals, peer details and impossible visible counts", () => {
  expect(ActivityBatchContextSchema.parse({ visibleCount: 1, complete: false })).toEqual({ visibleCount: 1, complete: false });
  for (const visibleCount of [0, 501, 1.5])
    expect(ActivityBatchContextSchema.safeParse({ visibleCount, complete: true }).success).toBe(false);
  expect(ActivityBatchContextSchema.safeParse({ visibleCount: 1, complete: true, total: 99 }).success).toBe(false);
  expect(ActivityBatchContextSchema.safeParse({ visibleCount: 1, complete: true, peers: [row] }).success).toBe(false);
});

test("chain and share access use the same request actor and preserve absent endpoints", async () => {
  const response = await client.api.filesv2.activity[":activityId"].chain.$get({ param: { activityId: id } });
  expect(await response.json()).toEqual(chain);
  const access = await client.api.filesv2.shares[":shareId"].access.$get({
    param: { shareId: id },
    query: { from: "2026-10-01", to: "2026-10-20" },
  });
  expect(await access.json()).toEqual(accessCounts);
  expect(calls.map((entry) => [entry.method, entry.call.actor, entry.input])).toEqual([
    ["movementChain", actor, { activityId: id }],
    ["shareAccess", actor, { shareId: id, from: "2026-10-01", to: "2026-10-20", networkLimit: 50 }],
  ]);
});
test("the chain HTTP request accepts a validated old descendant path and rejects malformed paths before the service", async () => {
  const response = await client.api.filesv2.activity[":activityId"].chain.$get({
    param: { activityId: id },
    query: { oldPath: "Old/child.txt" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(chain);
  expect(calls[0]?.input).toEqual({ activityId: id, oldPath: "Old/child.txt" });
  for (const oldPath of [
    "",
    "/Old/child",
    "Old/",
    "Old//child",
    "Old/../child",
    "Old/./child",
    "Old/.filegate/child",
    "Old\\child",
    "Old/\u0000child",
    "x".repeat(4097),
  ]) {
    calls.length = 0;
    expect(
      Number((await client.api.filesv2.activity[":activityId"].chain.$get({ param: { activityId: id }, query: { oldPath } })).status),
    ).toBe(400);
    expect(calls).toHaveLength(0);
  }
});

test("invisible or denied reads preserve HTTP 404/403 and operational failures stay failures", async () => {
  for (const status of [403, 404, 503] as const) {
    failure = new FilesError(status === 404 ? "not_found" : status === 403 ? "forbidden" : "unavailable", status);
    expect(Number((await client.api.filesv2.activity[":activityId"].chain.$get({ param: { activityId: id } })).status)).toBe(status);
  }
});
test("Assistant history queries use the current user with the original authorization and projection", async () => {
  const input = { q: "Old", limit: 2 };
  const list = filesCapabilities.queries["activity.list"];
  const result = await list.run(input, context);
  expect(result).toEqual({ ok: true, data: { data: page } });
  expect(calls[0]).toEqual({ method: "activity", call: { ...capabilityCall(context), requestAbort: context.signal }, input });
  expect(list.data.safeParse(page).success).toBe(true);
  expect(await filesCapabilities.queries["activity.chain"].run({ activityId: id }, context)).toEqual({ ok: true, data: { data: chain } });
  expect(await filesCapabilities.queries["share.access"].run({ shareId: id, from: "2026-10-01", to: "2026-10-20" }, context)).toMatchObject(
    { ok: true, data: { data: accessCounts } },
  );
});
test("positive schemas reject secret fields and over-disclosure on hidden and disappearance sides", () => {
  expect(ActivityEntrySchema.safeParse({ ...row, detail: { secret: "no" } }).success).toBe(false);
  expect(ActivityEntrySchema.safeParse({ ...row, after: { visibility: "hidden", path: "secret" } }).success).toBe(false);
  expect(ActivityEntrySchema.safeParse({ ...row, before: { ...row.before, itemId: id } }).success).toBe(false);
  for (const extra of [{ size: 1 }, { revision: "secret" }, { observation: { exists: true } }, { baseId: id }])
    expect(ActivityEntrySchema.safeParse({ ...row, before: { ...row.before, ...extra } }).success).toBe(false);
  const share = { expiresAt: "2030-06-01T00:00:00.000Z" };
  expect(ActivityEntrySchema.safeParse({ ...row, action: "share.create", share }).success).toBe(false);
  const full = {
    visibility: "full",
    source: "snapshot",
    name: "file",
    path: "file",
    root: "cloud",
    baseId: null,
    publicBaseId: null,
    itemId: null,
    directory: false,
    size: null,
    revision: null,
  };
  expect(ActivityEntrySchema.safeParse({ ...row, action: "share.create", after: full, share }).success).toBe(true);
  expect(ActivityEntrySchema.safeParse({ ...row, action: "share.revoke", after: full, share: { expiresAt: null } }).success).toBe(true);
  expect(ActivityEntrySchema.safeParse({ ...row, after: full, share }).success).toBe(false);
  expect(ActivityEntrySchema.safeParse({ ...row, action: "share.create", after: full, share: { ...share, token: "secret" } }).success).toBe(
    false,
  );
  expect(ActivityPageSchema.safeParse({ ...page, total: 100 }).success).toBe(false);
  expect(ActivityChainSchema.safeParse(chain).success).toBe(true);
  expect(ActivityChainSchema.safeParse({ ...chain, hops: [{ ...chain.hops[0], token: "private" }] }).success).toBe(false);
  expect(ActivityChainSchema.safeParse({ ...chain, hops: [{ ...chain.hops[0], actor: { ...row.actor, email: "private" } }] }).success).toBe(
    false,
  );
});

test("administrator base labels have a distinct bounded API and forward request cancellation", async () => {
  const controller = new AbortController();
  const response = await app.request(`http://cloud.test/api/filesv2/admin/activity/bases?q=Current&after=${id}`, {
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ items: [{ id: `cloud:users:${id}`, name: "Current user", kind: "users" }], next: null });
  expect(calls[0]?.method).toBe("adminActivityBases");
  expect(calls[0]?.input).toEqual({ q: "Current", after: id });
  const signal = calls[0]?.call.requestAbort;
  controller.abort();
  expect(signal?.aborted).toBe(true);
  calls.length = 0;
  for (const query of ["after=invalid", "q=", "limit=51"])
    expect((await app.request(`http://cloud.test/api/filesv2/admin/activity/bases?${query}`)).status).toBe(400);
  expect(calls).toEqual([]);
  failure = new FilesError("forbidden", 403);
  expect((await app.request("http://cloud.test/api/filesv2/admin/activity/bases")).status).toBe(403);
  failure = null;
  calls.length = 0;
  await client.api.filesv2.activity.bases.$get();
  expect(calls[0]?.method).toBe("baseNames");
});
test("oversized capability results fail visibly without shortening the page or changing its cursor", async () => {
  page.items = [{ ...row, via: "🍎".repeat(CAPABILITY_MAX_RESULT_BYTES) }];
  const result = await filesCapabilities.queries["activity.list"].run({}, context);
  expect(result).toMatchObject({ ok: false, error: { code: "result_too_large", status: 400 } });
  expect(page.next).toBe("opaque-next");
  expect(page.items).toHaveLength(1);
});
test("capability denial never becomes a successful empty page", async () => {
  failure = new FilesError("forbidden", 403);
  expect(await filesCapabilities.queries["activity.list"].run({}, context)).toMatchObject({ ok: false, error: { status: 403 } });
  failure = new FilesError("unavailable", 503);
  await expect(filesCapabilities.queries["activity.list"].run({}, context)).rejects.toMatchObject({ status: 503 });
});

const { default: filesCli } = await import("./cli");
function cliFixture(
  args: string[],
  flags: import("@k2b/cloud/cli").CloudCliContext["flags"] = {},
  output: "json" | "jsonl" | "text" = "json",
) {
  const lines: string[] = [];
  const requests: string[] = [];
  const ctx: import("@k2b/cloud/cli").CloudCliContext = {
    args,
    flags,
    options: { output, profile: "test", server: "http://cloud.test", token: "test-token" },
    createApiClient: ((base: string) =>
      hc(`http://cloud.test${base}`, {
        fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          requests.push(String(input));
          return app.request(input, init);
        },
      })) as import("@k2b/cloud/cli").CloudCliContext["createApiClient"],
    fetch: async () => {
      throw new Error("Unexpected untyped fetch");
    },
    readJson: async (response) => {
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      return response.json();
    },
    getDefault: async () => undefined,
    setDefault: async () => {},
    print: (value = "") => void lines.push(value),
    error: (value) => void lines.push(value),
    json: (value) => void lines.push(JSON.stringify(value)),
    jsonLine: (value) => void lines.push(JSON.stringify(value)),
    write: async () => {},
    table: () => {},
  };
  return { ctx, lines, requests };
}
test.each(["json", "jsonl"] as const)("CLI history preserves the page and every filter in %s", async (output) => {
  const f = cliFixture(
    ["history", "me:/Old/file.txt"],
    { folder: true, search: "Old/file.txt", actor: id, action: "item.move", from: row.time, to: row.time, after: "opaque", limit: "7" },
    output,
  );
  await filesCli.run(f.ctx);
  expect(JSON.parse(f.lines[0]!)).toEqual(page);
  expect(calls.map((call) => call.method)).toEqual(["baseNames", "activity"]);
  expect(calls[1]?.input).toEqual({
    baseId: `cloud:users:${actor.kind === "user" ? actor.user.id : ""}`,
    path: "Old/file.txt",
    scope: "folder",
    q: "Old/file.txt",
    actor: id,
    action: "item.move",
    from: row.time,
    to: row.time,
    cursor: "opaque",
    limit: 7,
  });
  expect(f.requests.every((url) => new URL(url).pathname.startsWith("/api/filesv2/activity"))).toBe(true);
});
test("CLI search without an address, chain lookup and share counts use their typed API routes", async () => {
  const search = cliFixture(["history"], { search: "Old" });
  await filesCli.run(search.ctx);
  expect(calls[0]?.input).toEqual({ q: "Old", scope: "item", limit: 50 });
  const follow = cliFixture(["history", "chain", id]);
  await filesCli.run(follow.ctx);
  expect(JSON.parse(follow.lines[0]!)).toEqual(chain);
  const access = cliFixture(["shares", "access", id], { from: "2026-10-01", to: "2026-10-20" });
  await filesCli.run(access.ctx);
  expect(JSON.parse(access.lines[0]!)).toEqual(accessCounts);
});
test.each(["stable", "persisted", "inline"])("CLI %s file references use the read-only reader adapter", async (form) => {
  const baseId = `cloud:users:${actor.kind === "user" ? actor.user.id : ""}`;
  const entryId =
    form === "stable"
      ? `n:${baseId}:${id}`
      : form === "persisted"
        ? `p:${"a".repeat(64)}`
        : btoa(`${baseId}\nOld/file.txt`).replace(/=/g, "");
  const f = cliFixture(["history", entryId]);
  await filesCli.run(f.ctx);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: "activityForEntry", input: { id: entryId, scope: "item", limit: 50 } });
  expect(f.requests).toHaveLength(1);
  expect(decodeURIComponent(new URL(f.requests[0]!).pathname)).toBe(`/api/filesv2/activity/entries/${entryId}`);
});
test("CLI text makes continuation and the search cap visible, including empty pages", async () => {
  page = { ...page, items: [], visibleCount: 0, scanLimitReached: true, searchLimitReached: true };
  const f = cliFixture(["history"], {}, "text");
  await filesCli.run(f.ctx);
  expect(f.lines.join("\n")).toContain("--after opaque-next");
  expect(f.lines.join("\n")).toContain("empty");
  expect(f.lines.join("\n")).toContain("200");
});

test("history capabilities compile with documented closed inputs and positive results", async () => {
  const { compileCapabilityManifest } = await import("@k2b/cloud/capabilities/testing");
  const manifest = compileCapabilityManifest("filesv2", filesCapabilities);
  expect(manifest.queries.map((query) => query.localId)).toEqual(
    expect.arrayContaining(["activity.list", "activity.chain", "share.access"]),
  );
  expect(filesCapabilities.queries["activity.list"].input.safeParse({ limit: 51 }).success).toBe(false);
  expect(filesCapabilities.queries["activity.list"].input.safeParse({ admin: true }).success).toBe(false);
});
test("all history capabilities reject a non-user actor before service access", async () => {
  const nonUser: CapabilityExecutionContext = {
    ...context,
    user: null,
    actor: {
      kind: "service_account",
      delegatedUser: null,
      scopes: ["read"],
      serviceAccount: {
        id: "service",
        name: "Studio",
        kind: "resource_bound",
        status: "active",
        delegatedUserId: null,
        appId: "assistant",
        resourceType: "app",
        resourceId: "app",
        createdBy: null,
        createdAt: "2026-10-01T00:00:00Z",
      },
    },
  };
  const list = await filesCapabilities.queries["activity.list"].run({}, nonUser);
  const follow = await filesCapabilities.queries["activity.chain"].run({ activityId: id }, nonUser);
  const access = await filesCapabilities.queries["share.access"].run({ shareId: id, from: "2026-10-01", to: "2026-10-20" }, nonUser);
  for (const result of [list, follow, access]) expect(result).toMatchObject({ ok: false, error: { status: 403 } });
  expect(calls).toHaveLength(0);
});

test("share network paging converts query strings and validates the complete reader contract", async () => {
  const response = await client.api.filesv2.shares[":shareId"].access.$get({
    param: { shareId: id },
    query: { from: "2026-10-01", to: "2026-10-20", networkAfter: "192.0.2.0/24", networkLimit: "3" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(accessCounts);
  expect(calls[0]?.input).toEqual({ shareId: id, from: "2026-10-01", to: "2026-10-20", networkAfter: "192.0.2.0/24", networkLimit: 3 });
  calls.length = 0;
  for (const query of [
    { networkAfter: "192.0.2.1" },
    { networkLimit: "51" },
    { networkLimit: "0" },
    { from: "2026-10-21" },
    { from: "2000-01-01" },
  ]) {
    const invalid = await client.api.filesv2.shares[":shareId"].access.$get({
      param: { shareId: id },
      query: { from: "2026-10-01", to: "2026-10-20", ...query },
    });
    expect(Number(invalid.status)).toBe(400);
    if (query.from)
      expect(await invalid.json()).toMatchObject({ code: "invalid_activity_filter", message: expect.stringContaining("date range") });
  }
  expect(calls).toHaveLength(0);
  const cli = cliFixture(["shares", "access", id], { from: "2026-10-01", to: "2026-10-20", after: "192.0.2.0/24", limit: "3" });
  await filesCli.run(cli.ctx);
  expect(calls[0]?.input).toEqual({ shareId: id, from: "2026-10-01", to: "2026-10-20", networkAfter: "192.0.2.0/24", networkLimit: 3 });
  expect(filesCapabilities.queries["share.access"].data.parse(accessCounts)).toEqual(accessCounts);
  expect(
    filesCapabilities.queries["share.access"].data.safeParse({
      ...accessCounts,
      networks: { ...accessCounts.networks, rawAddress: "192.0.2.1" },
    }).success,
  ).toBe(false);
});

test("timeline cursor reaches API, CLI and capability and rejects fabricated visitor detail", async () => {
  const query = { from: accessCounts.from, to: accessCounts.to, timelineAfter: row.time };
  const response = await client.api.filesv2.shares[":shareId"].access.$get({ param: { shareId: id }, query });
  expect(response.status).toBe(200);
  expect(calls[0]?.input).toEqual({ shareId: id, ...query, networkLimit: 50 });
  calls.length = 0;
  const cli = cliFixture(["shares", "access", id], { from: query.from, to: query.to, "timeline-after": row.time });
  await filesCli.run(cli.ctx);
  expect(calls[0]?.input).toEqual({ shareId: id, ...query, networkLimit: 50 });
  calls.length = 0;
  await filesCapabilities.queries["share.access"].run({ shareId: id, ...query }, context);
  expect(calls[0]?.input).toMatchObject({ shareId: id, ...query });
  const period = {
    date: row.time,
    granularity: "hour",
    pages: 3,
    pageNetworks: 1,
    downloads: 2,
    passwordFailed: 1,
    knownNetworks: 2,
    overflow: true,
  };
  const schema = filesCapabilities.queries["share.access"].data;
  expect(schema.safeParse({ ...accessCounts, timeline: { items: [period], next: row.time } }).success).toBe(true);
  expect(schema.safeParse({ ...accessCounts, timeline: { items: [{ ...period, pageNetworks: null }], next: null } }).success).toBe(true);
  expect(schema.safeParse({ ...accessCounts, timeline: { items: [{ ...period, pageNetworks: 0 }], next: null } }).success).toBe(true);
  const { pageNetworks: _pageNetworks, ...missingPageNetworks } = period;
  expect(schema.safeParse({ ...accessCounts, timeline: { items: [missingPageNetworks], next: null } }).success).toBe(false);
  for (const pageNetworks of [undefined, -1, 0.5, "1"])
    expect(schema.safeParse({ ...accessCounts, timeline: { items: [{ ...period, pageNetworks }], next: null } }).success).toBe(false);
  for (const extra of [{ visitorId: id }, { address: "192.0.2.1" }, { timestamp: row.time }])
    expect(schema.safeParse({ ...accessCounts, timeline: { items: [{ ...period, ...extra }], next: null } }).success).toBe(false);
  expect(schema.safeParse({ ...accessCounts, timeline: { items: Array(51).fill(period), next: null } }).success).toBe(false);
  const invalid = await client.api.filesv2.shares[":shareId"].access.$get({
    param: { shareId: id },
    query: { ...query, timelineAfter: "2030-05-01" },
  });
  expect(Number(invalid.status)).toBe(400);
  failure = new FilesError("share_access_cursor_expired", 409);
  const expired = await client.api.filesv2.shares[":shareId"].access.$get({ param: { shareId: id }, query });
  expect(Number(expired.status)).toBe(409);
  expect(await expired.json()).toMatchObject({ code: "share_access_cursor_expired", message: expect.stringContaining("Refresh") });
});

test("HTTP cancellation reaches the reader call and capability cancellation uses its original signal", async () => {
  const controller = new AbortController();
  const response = await app.request("http://cloud.test/api/filesv2/activity", { signal: controller.signal });
  expect(response.status).toBe(200);
  const forwarded = calls[0]?.call.requestAbort;
  expect(forwarded?.aborted).toBe(false);
  controller.abort();
  expect(forwarded?.aborted).toBe(true);
  calls.length = 0;
  await filesCapabilities.queries["activity.list"].run({}, { ...context, signal: controller.signal });
  expect(calls[0]?.call.requestAbort).toBe(controller.signal);
});

test("unreadable configuration remains an explicit conflict through API, CLI and capability history reads", async () => {
  failure = new FilesError("configuration_unreadable", 409);
  const response = await client.api.filesv2.activity.$get({ query: {} });
  expect(Number(response.status)).toBe(409);
  expect(await response.json()).toMatchObject({ code: "configuration_unreadable" });
  expect(await filesCapabilities.queries["activity.list"].run({}, context)).toMatchObject({
    ok: false,
    error: { code: "configuration_unreadable", status: 409 },
  });
  const f = cliFixture(["history"]);
  await expect(filesCli.run(f.ctx)).rejects.toThrow("409");
  expect(f.lines).toEqual([]);
});

test("visible relative display paths survive the wire schema but hidden paths are rejected", () => {
  expect(
    ActivitySideSchema.parse({
      visibility: "disappearance",
      name: "A",
      path: "users/u/Docs/A",
      directory: false,
      publicBaseId: "cloud:users:u",
      relativePath: "Docs/A",
    }),
  ).toMatchObject({ relativePath: "Docs/A" });
  expect(ActivitySideSchema.safeParse({ visibility: "hidden", relativePath: "secret/A" }).success).toBe(false);
  expect(
    ActivitySideSchema.safeParse({
      visibility: "disappearance",
      name: "A",
      path: "u/A",
      directory: false,
      publicBaseId: null,
      relativePath: null,
      itemId: "private",
    }).success,
  ).toBe(false);
});
