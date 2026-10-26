import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { REQUEST_IDLE_TIMEOUT_SECONDS } from "@k2b/cloud/server";
import { actorId, baseId, candidate, historyFixture, home, otherId, publicBaseId } from "../../test/activity-reader-fixture";
import { testActor, testCall } from "../../test/files-call";
import { withActivityReadBudget } from "./activity-read-budget";
import { FilesError } from "./errors";

const batchId = "30000000-0000-4000-8000-000000000001";
const previousSecret = process.env.APP_SECRET;
beforeAll(() => {
  process.env.APP_SECRET = "files-history-reader-test-secret";
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.APP_SECRET;
  else process.env.APP_SECRET = previousSecret;
});

const call = testCall(testActor);

test("projects disappeared source and current destination independently; fields and names use positive projection", async () => {
  const f = historyFixture();
  const page = await f.reader.activity(call);
  expect(page.items[0]?.before).toEqual({
    visibility: "disappearance",
    name: "old",
    path: `${home}/old`,
    directory: true,
    publicBaseId,
    relativePath: "old",
  });
  expect(page.items[0]?.after).toMatchObject({
    visibility: "full",
    source: "current",
    itemId: "stable-a",
    revision: "revision-new",
    observation: { exists: true, id: "stable-a" },
  });
  expect(page.items[0]?.actor.name).toBe("Live name");
  expect(JSON.stringify(page)).not.toMatch(/private|version-private|test-only-token/);
  f.names.delete(otherId);
  expect((await f.reader.activity(call)).items[0]?.actor.name).toBeNull();
});

test("a local grant covers historical items even when a later leaf lookup is refused", async () => {
  const f = historyFixture([candidate(1, { path_before: null, path_after: `${home}/secret-name` })]);
  f.nodes.set(`${home}/secret-name`, f.node(`${home}/secret-name`, "stable-a"));
  f.denied.add("secret-name");
  for (const input of [{}, { q: "secret-name" }, { baseId: publicBaseId, path: "secret-name" }, { itemId: "stable-a" }]) {
    const page = await f.reader.activity(call, input);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.after).toMatchObject({ visibility: "full", source: "snapshot" });
  }
  f.setMember(false);
  expect((await f.reader.activity(call)).items).toEqual([]);
});

test("a replaced identity exposes only disappearance fields to the readable parent", async () => {
  const f = historyFixture([candidate(1, { path_before: null })]);
  f.nodes.set(`${home}/new`, f.node(`${home}/new`, "replacement"));
  f.denied.add("new");
  const page = await f.reader.activity(call);
  expect(page.items[0]?.after).toEqual({
    visibility: "disappearance",
    name: "new",
    path: `${home}/new`,
    directory: true,
    publicBaseId,
    relativePath: "new",
  });
  expect(page.items[0]?.execution).toBeUndefined();
});

test("membership revocation and server/binding changes do not inherit parent access", async () => {
  const f = historyFixture();
  f.setMember(false);
  expect((await f.reader.activity(call)).items).toEqual([]);
  expect(f.requests).toEqual([]);
  await expect(f.reader.activityEntry(call, { activityId: candidate().id })).rejects.toMatchObject({ status: 404 });
  expect(f.requests).toEqual([]);
  f.setMember(true);
  expect((await f.reader.activity(call)).items).toHaveLength(1);
  f.setServer("http://another.test");
  expect((await f.reader.activity(call)).items).toEqual([]);
  const replaced = historyFixture([candidate(1, { base_id: "20000000-0000-4000-8000-000000000009" })]);
  expect((await replaced.reader.activity(call)).items).toEqual([]);
});

test("copy sides are separate: hidden destination cannot be found through search or filters", async () => {
  const f = historyFixture([
    candidate(1, {
      action: "item.copy",
      root_after: "other-root",
      base_after_id: "20000000-0000-4000-8000-000000000009",
      path_after: "secret/place/hidden-name",
    }),
  ]);
  const page = await f.reader.activity(call);
  expect(page.items[0]?.after).toEqual({ visibility: "hidden" });
  expect(JSON.stringify(page)).not.toMatch(/hidden-name|other-root|secret\/place/);
  expect((await f.reader.activity(call, { q: "hidden-name" })).items).toEqual([]);
  expect((await f.reader.movementChain(call, { activityId: candidate().id })).hops).toEqual([]);
});

test("own snapshots require a current local grant; administrators can read local historical bindings", async () => {
  const f = historyFixture([candidate(1, { actor_user_id: actorId })]);
  expect((await f.reader.activity(call)).items[0]?.after).toMatchObject({ visibility: "full", source: "snapshot" });
  f.setMember(false);
  expect((await f.reader.activity(call)).items).toEqual([]);
  await expect(f.reader.activityEntry(call, { activityId: candidate().id })).rejects.toMatchObject({ code: "not_found" });
  expect(f.requests).toEqual([]);
  const admin = historyFixture();
  admin.setAdmin(true);
  admin.setMember(false);
  expect((await admin.reader.activity(call)).items[0]?.before).toMatchObject({ visibility: "full", source: "snapshot" });
  expect((await admin.reader.activityEntry(call, { activityId: candidate().id })).after).not.toHaveProperty("observation");
});

test("no stable IDs limits both sides to minimal fields; IDs cannot be guessed through item filters", async () => {
  const f = historyFixture([candidate(1, { item_id: null, item_after_id: null })]);
  const page = await f.reader.activity(call);
  expect(page.items[0]?.after).toEqual({
    visibility: "disappearance",
    name: "new",
    path: `${home}/new`,
    directory: true,
    publicBaseId,
    relativePath: "new",
  });
  expect((await f.reader.activity(call, { itemId: "stable-a" })).items).toEqual([]);
  f.setStableIds(false);
  const stableDisabled = historyFixture();
  stableDisabled.setStableIds(false);
  expect((await stableDisabled.reader.activity(call)).items[0]?.after.visibility).toBe("disappearance");
});

test("folder moves match old descendant paths segmentwise and cache repeated parents", async () => {
  const f = historyFixture([candidate(), candidate(2)]);
  expect((await f.reader.activity(call, { q: "old/child/file.txt" })).items).toHaveLength(2);
  expect(f.authorized.filter((path) => path === "")).toHaveLength(0);
  expect((await f.reader.activity(call, { q: "older/child/file.txt" })).items).toEqual([]);
  expect((await f.reader.activity(call, { baseId: publicBaseId, path: "old/child" })).items).toHaveLength(2);
});

test("500-candidate scans and 50-row pages count only visible batch members; cursors reject tampering and changed filters", async () => {
  const rows = Array.from({ length: 550 }, (_, index) =>
    candidate(index + 1, { path_before: null, path_after: `${home}/${index < 50 ? "new" : "secret"}` }),
  );
  const f = historyFixture(rows);
  f.nodes.set(`${home}/secret`, f.node(`${home}/secret`, "stable-a"));
  f.denied.add("secret");
  const first = await f.reader.activity(call, { q: "new" });
  expect(first.items).toEqual([]);
  expect(first.scanLimitReached).toBe(true);
  expect(first.exhausted).toBe(false);
  expect(first.next).not.toBeNull();
  const second = await f.reader.activity(call, { q: "new", cursor: first.next! });
  expect(second.items).toHaveLength(50);
  expect(second.batches).toEqual([{ id: batchId, visibleCount: 50 }]);
  expect(second.next).toBeNull();
  expect(second.exhausted).toBe(true);
  expect(f.database.map((input) => input.limit)).toEqual([500, 500]);
  await expect(f.reader.activity(call, { cursor: `${first.next}tampered` })).rejects.toMatchObject({ code: "invalid_cursor" });
  await expect(f.reader.activity(call, { cursor: first.next!, q: "secret" })).rejects.toMatchObject({ code: "invalid_cursor" });
  const full = historyFixture(Array.from({ length: 75 }, (_, index) => candidate(index + 1)));
  expect((await full.reader.activity(call)).items).toHaveLength(50);
});

test("search stops at 200 projected hits across cursor pages, with an honest limit flag", async () => {
  const f = historyFixture(Array.from({ length: 250 }, (_, index) => candidate(index + 1)));
  let cursor: string | undefined;
  let count = 0;
  for (let index = 0; index < 4; index++) {
    const page = await f.reader.activity(call, { q: "new", cursor });
    count += page.items.length;
    cursor = page.next ?? undefined;
    expect(page.searchLimitReached).toBe(index === 3);
    if (index === 3) {
      expect(page.next).toBeNull();
      expect(page.exhausted).toBe(false);
    }
  }
  expect(count).toBe(200);
});

test("candidate windows round outward in UTC while inclusive exact filters follow projection", async () => {
  const times = ["12:09:59.999", "12:10:00.000", "12:20:00.000", "12:40:00.000", "12:40:00.001"];
  const f = historyFixture(
    times.map((time, index) =>
      candidate(index + 1, {
        effective_time: `2030-05-15T${time}Z`,
        actor_user_id: actorId,
      }),
    ),
  );
  // Exact filters apply to authorized own snapshots.
  const page = await f.reader.activity(call, {
    from: "2030-05-15T14:10:00.000+02:00",
    to: "2030-05-15T14:40:00.000+02:00",
    actor: actorId,
    action: "item.move",
    q: "new",
    itemId: "stable-a",
  });
  expect(page.items.map((row) => row.id)).toEqual([candidate(4).id, candidate(3).id, candidate(2).id]);
  expect(page.visibleCount).toBe(3);
  expect(page.batches).toEqual([{ id: batchId, visibleCount: 3 }]);
  expect(page.exhausted).toBe(true);
  expect(f.database[0]).toEqual({
    position: null,
    direction: "desc",
    limit: 500,
    from: "2030-05-15T12:00:00.000Z",
    to: "2030-05-15T13:00:00.000Z",
    scope: { admin: false, userId: actorId, bindingIds: [baseId], serverUrl: "http://filegate.test" },
    baseId: undefined,
  });
  expect(f.requests).toEqual([]);
  expect(f.authorized).toEqual([]);
});

test("exact-hour and sub-millisecond bounds preserve SQL microseconds after projection", async () => {
  const f = historyFixture(
    [0, 1, 2].map((microseconds, index) =>
      candidate(index + 1, {
        effective_time: `2030-05-15 12:00:00.00000${microseconds}+00`,
        actor_user_id: actorId,
      }),
    ),
  );
  const input = { from: "2030-05-15T12:00:00.000001Z", to: "2030-05-15T12:00:00.000001Z" };
  expect((await f.reader.activity(call, input)).items.map((row) => row.id)).toEqual([candidate(2).id]);
  expect(f.database[0]?.to).toBe("2030-05-15T13:00:00.000Z");
  const onHour = await f.reader.activity(call, { from: "2030-05-15T12:00:00Z", to: "2030-05-15T12:00:00Z" });
  expect(onHour.items.map((row) => row.id)).toEqual([candidate(1).id]);
  expect(f.database[1]?.to).toBe("2030-05-15T12:00:00.000Z");
  await expect(f.reader.activity(call, { from: "2030-05-15T12:00:00.000002Z", to: input.to })).rejects.toMatchObject({
    code: "invalid_activity_filter",
  });
  expect(f.database).toHaveLength(2);
});

test("within-hour exact filters cannot alter hidden candidate windows or reuse each other's cursor", async () => {
  const f = historyFixture(
    Array.from({ length: 501 }, (_, index) =>
      candidate(index + 1, {
        effective_time: "2030-05-15T12:20:00.000Z",
        path_before: null,
        path_after: `${home}/secret`,
      }),
    ),
  );
  f.nodes.set(`${home}/secret`, f.node(`${home}/secret`, "stable-a"));
  f.denied.add("secret");
  const a = { from: "2030-05-15T12:10:00Z", to: "2030-05-15T12:11:00Z" };
  const b = { from: "2030-05-15T12:30:00Z", to: "2030-05-15T12:31:00Z" };
  const first = await f.reader.activity(call, a);
  const second = await f.reader.activity(call, b);
  expect(first.items).toEqual([]);
  expect(second.items).toEqual([]);
  expect(first.scanLimitReached).toBe(true);
  expect(second.scanLimitReached).toBe(true);
  expect(first.next).not.toBeNull();
  expect(second.next).not.toBeNull();
  expect(f.database[0]).toEqual(f.database[1]);
  for (const changed of [
    { ...a, from: "2030-05-15T12:10:01Z" },
    { ...a, to: "2030-05-15T12:11:01Z" },
  ])
    await expect(f.reader.activity(call, { ...changed, cursor: first.next! })).rejects.toMatchObject({ code: "invalid_cursor" });
  expect(f.database).toHaveLength(2);
});

test.each([undefined, "new"])("exact-time pagination preserves page limits and continuation with q=%s", async (q) => {
  const middle = [1, 2, 3].map((index) =>
    candidate(index, {
      effective_time: "2030-05-15T12:20:00.000Z",
      actor_user_id: actorId,
    }),
  );
  const f = historyFixture([
    ...Array.from({ length: 501 }, (_, index) =>
      candidate(index + 4, {
        effective_time: "2030-05-15T12:50:00.000Z",
        actor_user_id: actorId,
      }),
    ),
    ...middle,
    candidate(505, { effective_time: "2030-05-15T12:05:00.000Z", actor_user_id: actorId }),
  ]);
  const input = { from: "2030-05-15T12:10:00Z", to: "2030-05-15T12:30:00Z", limit: 2, q };
  const first = await f.reader.activity(call, input);
  expect(first.items).toEqual([]);
  expect(first.scanLimitReached).toBe(true);
  expect(first.next).not.toBeNull();
  const second = await f.reader.activity(call, { ...input, cursor: first.next! });
  expect(second.items.map((row) => row.id)).toEqual([candidate(3).id, candidate(2).id]);
  expect(second.scanLimitReached).toBe(false);
  expect(second.next).not.toBeNull();
  const third = await f.reader.activity(call, { ...input, cursor: second.next! });
  expect(third.items.map((row) => row.id)).toEqual([candidate(1).id]);
  expect(third.next).toBeNull();
  expect(third.exhausted).toBe(true);
  expect(f.database.map((input) => input.limit)).toEqual([500, 500, 500]);
});

test("search's 200-match cap counts exact-time matches across coarse scan windows only", async () => {
  const f = historyFixture([
    ...Array.from({ length: 501 }, (_, index) =>
      candidate(index + 1, {
        effective_time: "2030-05-15T12:50:00.000Z",
        actor_user_id: actorId,
      }),
    ),
    ...Array.from({ length: 201 }, (_, index) =>
      candidate(index + 502, {
        effective_time: "2030-05-15T12:20:00.000Z",
        actor_user_id: actorId,
      }),
    ),
  ]);
  const input = { from: "2030-05-15T12:10:00Z", to: "2030-05-15T12:30:00Z", q: "new" };
  let cursor: string | undefined;
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) {
    const page = await f.reader.activity(call, { ...input, cursor });
    ids.push(...page.items.map((row) => row.id));
    expect(page.items).toHaveLength(index === 0 ? 0 : 50);
    expect(page.searchLimitReached).toBe(index === 4);
    expect(page.scanLimitReached).toBe(index === 0);
    if (index < 4) expect(page.next).not.toBeNull();
    else expect(page.next).toBeNull();
    cursor = page.next ?? undefined;
  }
  expect(ids).toHaveLength(200);
  expect(new Set(ids).size).toBe(200);
});

test("chain verifies the endpoint through resolve and fresh access, and reports probable without IDs", async () => {
  const f = historyFixture();
  const chain = await f.reader.movementChain(call, { activityId: candidate().id });
  expect(chain.endpoint).toEqual({ baseId: publicBaseId, path: "new", itemId: "stable-a" });
  expect(chain.certainty).toBe("verified");
  expect(f.requests.some((path) => path.includes("resolve"))).toBe(true);
  const probable = historyFixture([candidate(1, { item_id: null, item_after_id: null })]);
  expect((await probable.reader.movementChain(call, { activityId: candidate().id })).certainty).toBe("probable");
});

test("chain handles ancestor replacements without prefix collisions and truncates at 20 hops", async () => {
  const rows = [
    candidate(1, { path_after: `${home}/a/file`, directory: false }),
    candidate(2, { path_before: `${home}/ab`, path_after: `${home}/collision`, item_id: "different", item_after_id: "different" }),
    ...Array.from({ length: 23 }, (_, index) =>
      candidate(index + 3, {
        path_before: `${home}/${index === 0 ? "a" : `a${index}`}`,
        path_after: `${home}/a${index + 1}`,
        item_id: "ancestor",
        item_after_id: "ancestor",
      }),
    ),
  ];
  const f = historyFixture(rows);
  f.setAdmin(true);
  f.nodes.delete(`${home}/new`);
  f.nodes.set(`${home}/a23/file`, f.node(`${home}/a23/file`, "stable-a", false));
  const chain = await f.reader.movementChain(call, { activityId: rows[0]!.id });
  expect(chain.hops).toHaveLength(20);
  expect(chain.truncated).toBe(true);
  expect(chain.hops.some((hop) => hop.activityId === rows[1]!.id)).toBe(false);
  expect(chain.endpoint?.path).toBe("a23/file");
  expect(chain.historyComplete).toBe(false);
  f.denied.add("a23/file");
  expect((await f.reader.movementChain(call, { activityId: rows[0]!.id })).endpoint).toBeNull();
});

test("unknown actions fail closed and full-only version metadata stays action specific", async () => {
  const f = historyFixture([candidate(1, { action: "unknown.future" }), candidate(2, { action: "version.restore" })]);
  const page = await f.reader.activity(call);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.after).toMatchObject({ versionId: "version-private" });
  expect(page.items[0]?.before).not.toHaveProperty("versionId");
});

test("privileged 403 never means missing, and outages remain visible failures", async () => {
  const f = historyFixture([candidate(1, { path_before: null })]);
  f.statFailures.set(`${home}/new`, 403);
  expect((await f.reader.activity(call)).items[0]?.after).toMatchObject({ source: "snapshot" });
  expect(f.authorized).toEqual([]);
  f.statFailures.set(`${home}/new`, 500);
  await expect(f.reader.activity(call)).rejects.toMatchObject({ status: 500 });
});

test("a refused current target preserves the authorized local snapshot without navigation", async () => {
  const f = historyFixture([candidate(1, { path_before: null })]);
  const original = f.deps.requestContext;
  f.deps.requestContext = async (...args) => {
    const current = await original(...args);
    return {
      ...current,
      readOnlyAuthorized: async (base, path) => {
        if (path === "new") throw new FilesError("not_found", 404);
        return current.readOnlyAuthorized(base, path);
      },
    };
  };
  expect((await f.reader.activity(call)).items[0]?.after).toMatchObject({ source: "snapshot" });
  expect(f.authorized).toEqual([]);
});

test("an unrelated execution ID never appears with minimal-only visibility", async () => {
  const f = historyFixture([candidate(1, { path_after: null })]);
  const row = (await f.reader.activity(call)).items[0]!;
  expect(row.before.visibility).toBe("disappearance");
  expect(row.after).toEqual({ visibility: "hidden" });
  expect(row.execution).toBeUndefined();
  expect(row.before).not.toHaveProperty("observation");
});

test("share expiry is projected only for full share events, never hidden or disappearance sides", async () => {
  const expiresAt = new Date("2030-06-01T00:00:00Z");
  for (const action of ["share.create", "share.revoke"] as const) {
    const f = historyFixture([candidate(1, { action, share_expires_at: expiresAt, path_before: null })]);
    expect((await f.reader.activity(call)).items[0]?.share).toEqual({ expiresAt: expiresAt.toISOString() });
    const own = historyFixture([candidate(1, { action, actor_user_id: actorId, share_expires_at: expiresAt })]);
    own.setMember(true);
    expect((await own.reader.activity(call)).items[0]?.share).toEqual({ expiresAt: expiresAt.toISOString() });
    const admin = historyFixture([candidate(1, { action, share_expires_at: null })]);
    admin.setAdmin(true);
    expect((await admin.reader.activity(call)).items[0]?.share).toEqual({ expiresAt: null });
    f.nodes.set(`${home}/new`, f.node(`${home}/new`, "replacement"));
    const minimal = (await f.reader.activity(call)).items[0]!;
    expect(minimal.after.visibility).toBe("disappearance");
    expect(minimal.share).toBeUndefined();
    f.setMember(false);
    expect((await f.reader.activity(call)).items).toEqual([]);
  }
  const unrelated = historyFixture([candidate(1, { share_expires_at: expiresAt })]);
  expect((await unrelated.reader.activity(call)).items[0]?.share).toBeUndefined();
});

test("disappearance retains historical file/folder type without claiming snapshot membership", async () => {
  const f = historyFixture([candidate(1, { directory: false, path_after: null })]);
  expect((await f.reader.activity(call)).items[0]?.before).toEqual({
    visibility: "disappearance",
    name: "old",
    path: `${home}/old`,
    directory: false,
    publicBaseId,
    relativePath: "old",
  });
  f.setMember(false);
  expect((await f.reader.activity(call)).items).toEqual([]);
  const legacy = historyFixture([candidate(1, { actor_user_id: actorId, metadataUnknown: true })]);
  legacy.setMember(true);
  const side = (await legacy.reader.activity(call)).items[0]?.before;
  expect(side).toEqual({
    visibility: "disappearance",
    name: "old",
    path: `${home}/old`,
    directory: null,
    publicBaseId,
    relativePath: "old",
  });
  expect(side).not.toHaveProperty("size");
  expect(side).not.toHaveProperty("itemId");
  expect(side).not.toHaveProperty("revision");
  expect(side).not.toHaveProperty("observation");
});

test("chain crosses edits and copies without inventing hops, and checks endpoint permissions again after resolve", async () => {
  const source = candidate(1);
  const f = historyFixture([
    source,
    candidate(2, { action: "file.edit", path_before: `${home}/new`, path_after: `${home}/new` }),
    candidate(3, { action: "item.copy", path_before: `${home}/new`, path_after: `${home}/copy`, item_after_id: "copy-id" }),
    candidate(4, { path_before: `${home}/new`, path_after: `${home}/final` }),
  ]);
  f.nodes.delete(`${home}/new`);
  f.nodes.set(`${home}/final`, f.node(`${home}/final`, "stable-a"));
  const chain = await f.reader.movementChain(call, { activityId: source.id });
  expect(chain.hops.map((row) => row.activityId)).toEqual([source.id, candidate(4).id]);
  expect(chain.endpoint?.path).toBe("final");
  expect(chain.truncated).toBe(false);
  expect(f.authorized.filter((path) => path === "final")).toHaveLength(2);
});

test("pagination survives a new invocation and live actor-name changes while remaining identity bound", async () => {
  if (testActor.kind !== "user") throw new Error("Expected user actor");
  const actor = testActor;
  const f = historyFixture(Array.from({ length: 60 }, (_, index) => candidate(index + 1)));
  const delegated = (invocationId: string) =>
    testCall({
      ...actor,
      user: { ...actor.user, displayName: invocationId },
      delegation: { kind: "invocation", callingAppId: "assistant", credentialKind: "session", invocationId },
    });
  const first = await f.reader.activity(delegated("first"));
  expect((await f.reader.activity(delegated("second"), { cursor: first.next! })).items).toHaveLength(10);
  const otherActor = testCall({ ...actor, user: { ...actor.user, id: otherId } });
  await expect(f.reader.activity(otherActor, { cursor: first.next! })).rejects.toMatchObject({ code: "invalid_cursor" });
});

test("local grants preserve minimal no-ID history when current leaf access fails", async () => {
  const f = historyFixture([candidate(1, { path_before: null, item_after_id: null })]);
  f.denied.add("");
  expect((await f.reader.activity(call)).items[0]?.after.visibility).toBe("disappearance");
  f.denied.add("new");
  expect((await f.reader.activity(call)).items).toHaveLength(1);
  f.setMember(false);
  expect((await f.reader.activity(call)).items).toEqual([]);
});

test("sparse actor/action filters consume only one bounded candidate window", async () => {
  const f = historyFixture([
    candidate(1),
    ...Array.from({ length: 500 }, (_, index) => candidate(index + 2, { actor_user_id: actorId, action: "folder.create" })),
  ]);
  const input = { actor: otherId, action: "item.move" as const };
  const first = await f.reader.activity(call, input);
  expect(first.items).toEqual([]);
  expect(first.scanLimitReached).toBe(true);
  expect(f.database[0]).not.toHaveProperty("actor");
  expect(f.database[0]).not.toHaveProperty("action");
  const last = await f.reader.activity(call, { ...input, cursor: first.next! });
  expect(last.items.map((row) => row.id)).toEqual([candidate(1).id]);
  expect(last.exhausted).toBe(true);
});

test("unknown snapshot metadata stays minimal for own, admin and currently authorized viewers", async () => {
  for (const viewer of ["own", "admin", "reader"] as const) {
    const row = candidate(1, {
      action: "share.revoke",
      metadataUnknown: true,
      directory: false,
      actor_user_id: viewer === "own" ? actorId : otherId,
      // Even accidentally populated fields cannot turn unknown metadata into a type claim.
      path_before: `${home}/new`,
      path_after: null,
    });
    const f = historyFixture([row]);
    f.setAdmin(viewer === "admin");
    f.setMember(viewer !== "admin");
    const page = await f.reader.activity(call);
    expect(page.items[0]?.before).toEqual({
      visibility: "disappearance",
      name: "new",
      path: `${home}/new`,
      directory: null,
      publicBaseId: viewer !== "admin" ? publicBaseId : null,
      relativePath: viewer !== "admin" ? "new" : null,
    });
    expect(page.items[0]?.execution).toBeUndefined();
    expect(JSON.stringify(page)).not.toMatch(/revision|observation|stable-a|version-private/);
    expect((await f.reader.activity(call, { itemId: "stable-a" })).items).toEqual([]);
    if (viewer !== "reader") expect(f.requests).toEqual([]);
    if (viewer === "reader") {
      f.setMember(false);
      expect((await f.reader.activity(call)).items).toEqual([]);
    }
  }
});

test("unknown directory metadata cannot assert ancestor movement or resolve a movement endpoint", async () => {
  const source = candidate(1, { metadataUnknown: true });
  const f = historyFixture([source]);
  f.setAdmin(true);
  expect((await f.reader.activity(call, { baseId: publicBaseId, path: "old/child" })).items).toEqual([]);
  expect((await f.reader.activity(call, { q: "old/child" })).items).toEqual([]);
  expect((await f.reader.movementChain(call, { activityId: source.id })).endpoint).toBeNull();
  expect(f.requests).toEqual([]);
  const later = historyFixture([candidate(1), candidate(2, { metadataUnknown: true, path_before: `${home}/new` })]);
  later.setAdmin(true);
  const chain = await later.reader.movementChain(call, { activityId: candidate(1).id });
  expect(chain.hops).toHaveLength(1);
  expect(chain.truncated).toBe(true);
});

test("single event uses the same projection and returns not_found for hidden or absent IDs", async () => {
  const row = candidate(1, { path_before: null, path_after: `${home}/secret-name` });
  const f = historyFixture([row]);
  f.nodes.set(`${home}/secret-name`, f.node(`${home}/secret-name`, "stable-a"));
  f.setMember(false);
  await expect(f.reader.activityEntry(call, { activityId: row.id })).rejects.toMatchObject({ code: "not_found", status: 404 });
  await expect(f.reader.activityEntry(call, { activityId: candidate(2).id })).rejects.toMatchObject({ code: "not_found", status: 404 });
  f.setMember(true);
  const page = await f.reader.activity(call);
  expect(await f.reader.activityEntry(call, { activityId: row.id })).toEqual(page.items[0]!);
});

test("foreign installation volume cannot change empty pages, search counts or continuation presence", async () => {
  const empty = historyFixture([]);
  const noisy = historyFixture(
    Array.from({ length: 700 }, (_, index) =>
      candidate(index + 1, {
        base_id: "20000000-0000-4000-8000-000000000009",
        base_after_id: null,
        path_before: "secret/hidden-name",
        path_after: "secret/hidden-name",
      }),
    ),
  );
  for (const input of [{}, { q: "hidden-name" }, { q: "absent-name" }, { baseId: publicBaseId }]) {
    expect(await noisy.reader.activity(call, input)).toEqual(await empty.reader.activity(call, input));
  }
  expect(noisy.requests).toEqual([]);
  expect(noisy.authorized).toEqual([]);
});

test("a hidden name on another side never changes projected search counts or continuation presence", async () => {
  const row = candidate(1, { action: "item.copy", root_after: "private-root", base_after_id: "20000000-0000-4000-8000-000000000009" });
  const a = historyFixture([row]);
  const b = historyFixture([{ ...row, path_after: "private/guess-this-name" }]);
  for (const q of ["guess-this-name", "not-present", "old"]) {
    expect(await b.reader.activity(call, { q })).toEqual(await a.reader.activity(call, { q }));
  }
});

test("unrelated 500+ rows cannot truncate a relevant chain; every hop projects actor and via", async () => {
  const rows = [
    candidate(1),
    ...Array.from({ length: 600 }, (_, index) =>
      candidate(index + 2, {
        path_before: `${home}/unrelated-${index}`,
        path_after: `${home}/elsewhere-${index}`,
      }),
    ),
    candidate(602, { path_before: `${home}/new`, path_after: `${home}/final`, via: "app:files" }),
  ];
  const f = historyFixture(rows);
  f.nodes.delete(`${home}/new`);
  f.nodes.set(`${home}/final`, f.node(`${home}/final`, "stable-a"));
  const chain = await f.reader.movementChain(call, { activityId: rows[0]!.id });
  expect(chain.hops.map((hop) => hop.activityId)).toEqual([rows[0]!.id, rows.at(-1)!.id]);
  expect(chain.hops[1]).toMatchObject({ actor: { kind: "user", userId: otherId, name: "Live name" }, via: "app:files" });
  expect(chain.truncated).toBe(false);
  expect(chain.endpoint?.path).toBe("final");
  expect(f.database.every((input) => input.chain && input.limit === 1)).toBe(true);
});

test("truncation without stable identity never offers an actionable probable endpoint", async () => {
  const f = historyFixture([
    candidate(1, { item_id: null, item_after_id: null }),
    candidate(2, {
      action: "item.trash",
      path_before: `${home}/new`,
      path_after: null,
      item_id: null,
      item_after_id: null,
    }),
  ]);
  const chain = await f.reader.movementChain(call, { activityId: candidate().id });
  expect(chain.truncated).toBe(true);
  expect(chain.endpoint).toBeNull();
  expect(chain.certainty).toBe("unavailable");
});

test("cancellation during a query returns no partial page, starts no projections, and releases its budget", async () => {
  const f = historyFixture();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.deps.data!.candidates = async (_input, budget) =>
    budget!.run(
      () =>
        new Promise((_, reject) => {
          budget!.signal.addEventListener("abort", () => reject(budget!.signal.reason), { once: true });
          started();
        }),
    );
  const result = f.reader.activity({ ...call, requestAbort: controller.signal });
  // Observe rejection without starting Bun's async matcher before we trigger cancellation.
  const outcome = result.then(
    () => null,
    (error: unknown) => error,
  );
  await ready;
  controller.abort(new Error("reader canceled"));
  expect(await outcome).toMatchObject({ message: "reader canceled" });
  expect(f.requests).toEqual([]);
  expect(f.authorized).toEqual([]);
});

test("already canceled calls do not begin identity, SQL or storage work", async () => {
  const f = historyFixture();
  const controller = new AbortController();
  controller.abort(new Error("already canceled"));
  let contexts = 0;
  const original = f.deps.requestContext;
  f.deps.requestContext = async (...args) => {
    contexts++;
    return original(...args);
  };
  await expect(f.reader.activity({ ...call, requestAbort: controller.signal })).rejects.toThrow("already canceled");
  expect(contexts).toBe(0);
  expect(f.database).toEqual([]);
  expect(f.requests).toEqual([]);
});

test("one total HTTP budget cancels in-flight work and clears its timer, rather than restarting per leaf", async () => {
  const schedule = spyOn(globalThis, "setTimeout");
  const clear = spyOn(globalThis, "clearTimeout");
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancel = 0;
  try {
    const result = withActivityReadBudget(undefined, async (budget) => {
      await budget.run(async () => "first leaf");
      await budget.run(
        () =>
          new Promise<void>(() => {
            started();
          }),
        () => {
          cancel++;
        },
      );
      throw new Error("must not proceed after deadline");
    });
    const outcome = result.then(
      () => null,
      (error: unknown) => error,
    );
    await ready;
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0]?.[1]).toBe(REQUEST_IDLE_TIMEOUT_SECONDS * 1000);
    const fire = schedule.mock.calls[0]?.[0];
    if (typeof fire !== "function") throw new Error("Expected the total deadline callback");
    fire();
    expect(await outcome).toMatchObject({ code: "unavailable", status: 503 });
    expect(cancel).toBe(1);
    expect(clear).toHaveBeenCalledTimes(1);
  } finally {
    schedule.mockRestore();
    clear.mockRestore();
  }
});

test("scan flag reports interruptions rather than a full page ending on candidate 500", async () => {
  const f = historyFixture(
    Array.from({ length: 500 }, (_, index) =>
      candidate(index + 1, {
        path_before: null,
        path_after: `${home}/${index < 50 ? "new" : "secret"}`,
      }),
    ),
  );
  f.nodes.set(`${home}/secret`, f.node(`${home}/secret`, "stable-a"));
  f.denied.add("secret");
  const page = await f.reader.activity(call);
  expect(page.items).toHaveLength(50);
  expect(page.scanLimitReached).toBe(false);
  expect(page.next).not.toBeNull();
});

test.each([
  "folder.create",
  "file.create",
  "file.upload",
  "file.overwrite",
  "item.copy",
  "item.restore",
  "version.restore_copy",
  "item.move",
  "item.rename",
  "place.restore",
])("path-only chains stop at a confirmed %s arrival at the destination or its ancestor", async (action) => {
  for (const ancestor of [false, true]) {
    const path = `${home}/new${ancestor ? "/child" : ""}`;
    const source = candidate(1, {
      path_after: path,
      directory: ancestor ? false : action === "folder.create",
      item_id: null,
      item_after_id: null,
    });
    const inbound = ["item.copy", "item.move", "item.rename", "place.restore", "item.restore", "version.restore_copy"].includes(action);
    const replacement = candidate(2, {
      action,
      path_before: inbound ? "elsewhere/source" : action === "file.overwrite" ? `${home}/new` : null,
      path_after: `${home}/new`,
      root: inbound ? "elsewhere" : "cloud",
      root_after: inbound ? "cloud" : null,
      base_id: inbound ? null : source.base_id,
      base_after_id: inbound ? source.base_id : null,
      directory: ancestor || action === "folder.create",
      item_id: null,
      item_after_id: null,
    });
    const f = historyFixture([source, replacement]);
    f.setAdmin(true);
    f.setStableIds(false);
    f.nodes.set(path, f.node(path, undefined, source.directory));
    const chain = await f.reader.movementChain(call, { activityId: source.id });
    expect(chain.hops.map((hop) => hop.activityId)).toEqual([source.id]);
    expect(chain.truncated).toBe(true);
    expect(chain.endpoint).toBeNull();
    expect(chain.certainty).toBe("unavailable");
    expect(f.requests.some((request) => request.includes("resolve"))).toBe(false);
  }
});

test.each(["item.trash", "item.purge"])("path-only chains cannot resolve a recreated path after %s", async (action) => {
  const source = candidate(1, { item_id: null, item_after_id: null });
  const f = historyFixture([
    source,
    candidate(2, { action, path_before: `${home}/new`, path_after: null, item_id: null, item_after_id: null }),
    candidate(3, { action: "folder.create", path_before: null, path_after: `${home}/new`, item_id: null, item_after_id: null }),
  ]);
  f.setAdmin(true);
  f.setStableIds(false);
  const chain = await f.reader.movementChain(call, { activityId: source.id });
  expect(chain.truncated).toBe(true);
  expect(chain.endpoint).toBeNull();
});

test.each(["folder.create", "file.create", "file.upload", "file.overwrite"])(
  "recorded same-identity %s leaves a valid chain intact",
  async (action) => {
    for (const initialId of [null, "stable-a"]) {
      const source = candidate(1, { item_id: initialId, item_after_id: initialId });
      const f = historyFixture([
        source,
        candidate(2, { action, path_before: `${home}/new`, path_after: `${home}/new` }),
        candidate(3, { path_before: `${home}/new`, path_after: `${home}/final` }),
      ]);
      f.setAdmin(true);
      f.nodes.set(`${home}/final`, f.node(`${home}/final`, "stable-a"));
      f.nodes.delete(`${home}/new`);
      const chain = await f.reader.movementChain(call, { activityId: source.id });
      expect(chain.hops.map((hop) => hop.activityId)).toEqual([source.id, candidate(3).id]);
      expect(chain.truncated).toBe(false);
      expect(chain.endpoint?.path).toBe("final");
    }
  },
);

test("a path-only copy source and lexical ancestor collision do not end its movement lifetime", async () => {
  const source = candidate(1, { item_id: null, item_after_id: null, path_after: `${home}/new/child`, directory: false });
  const f = historyFixture([
    source,
    candidate(2, { action: "item.copy", path_before: `${home}/new`, path_after: `${home}/copy`, item_id: null, item_after_id: null }),
    candidate(3, { action: "folder.create", path_before: null, path_after: `${home}/ne`, item_id: null, item_after_id: null }),
    candidate(4, { path_before: `${home}/new`, path_after: `${home}/final`, item_id: null, item_after_id: null }),
  ]);
  f.setAdmin(true);
  f.setStableIds(false);
  f.nodes.set(`${home}/final/child`, f.node(`${home}/final/child`, undefined, false));
  const chain = await f.reader.movementChain(call, { activityId: source.id });
  expect(chain.hops.map((hop) => hop.activityId)).toEqual([source.id, candidate(4).id]);
  expect(chain.truncated).toBe(false);
  expect(chain.endpoint?.path).toBe("final/child");
  expect(chain.certainty).toBe("probable");
});

test.each(["folder.create", "file.create", "file.upload"])(
  "known identity survives a %s arrival with no before-side snapshot",
  async (action) => {
    const source = candidate(1);
    const f = historyFixture([
      source,
      candidate(2, { action, path_before: null, path_after: `${home}/new`, item_id: null }),
      candidate(3, { path_before: `${home}/new`, path_after: `${home}/final` }),
    ]);
    f.setAdmin(true);
    f.nodes.delete(`${home}/new`);
    f.nodes.set(`${home}/final`, f.node(`${home}/final`, "stable-a"));
    const chain = await f.reader.movementChain(call, { activityId: source.id });
    expect(chain.truncated).toBe(false);
    expect(chain.hops.map((hop) => hop.activityId)).toEqual([source.id, candidate(3).id]);
    expect(chain.endpoint).toEqual({ baseId: publicBaseId, path: "final", itemId: "stable-a" });
  },
);

test("display paths are base-relative only on independently approved sides, including disappearance", async () => {
  const f = historyFixture();
  const row = (await f.reader.activity(call)).items[0]!;
  expect(row.before).toEqual({
    visibility: "disappearance",
    name: "old",
    path: `${home}/old`,
    directory: true,
    publicBaseId,
    relativePath: "old",
  });
  expect(row.after).toMatchObject({ visibility: "full", source: "current", publicBaseId, relativePath: "new" });
  expect(row.before).not.toHaveProperty("itemId");
  expect(row.before).not.toHaveProperty("size");
  f.denied.add("new");
  const restricted = (await f.reader.activity(call)).items[0]!;
  expect(restricted.before).toMatchObject({ relativePath: "old" });
  expect(restricted.after).toMatchObject({ visibility: "full", source: "snapshot", relativePath: "new" });
});

test("own snapshots may name a current binding without acquiring current item authority", async () => {
  const f = historyFixture([candidate(1, { actor_user_id: actorId })]);
  const row = (await f.reader.activity(call)).items[0]!;
  for (const [side, relativePath] of [
    [row.before, "old"],
    [row.after, "new"],
  ] as const) {
    expect(side).toMatchObject({ visibility: "full", source: "snapshot", publicBaseId, relativePath });
    expect(side).not.toHaveProperty("observation");
  }
  expect(f.authorized).toEqual([]);
  expect(f.requests).toEqual([]);
  f.setMember(false);
  expect((await f.reader.activity(call)).items).toEqual([]);
  const legacy = historyFixture([candidate(1, { actor_user_id: actorId, metadataUnknown: true })]);
  legacy.setMember(false);
  expect((await legacy.reader.activity(call)).items).toEqual([]);
});

test("an old descendant address uses its own fresh leaf, never the moved ancestor's stable identity", async () => {
  const source = candidate();
  const f = historyFixture([source]);
  f.nodes.set(`${home}/new/child.txt`, f.node(`${home}/new/child.txt`, "child-id", false));
  const chain = await f.reader.movementChain(call, { activityId: source.id, oldPath: "old/child.txt" });
  expect(chain.endpoint).toEqual({ baseId: publicBaseId, path: "new/child.txt", itemId: null });
  expect(chain.certainty).toBe("probable");
  expect(chain.historyComplete).toBe(false);
  expect(chain.truncated).toBe(false);
  expect(f.authorized).toContain("new/child.txt");
  expect(f.requests.some((request) => request.includes("resolve"))).toBe(false);
  // The exact request retains the ancestor's identity and existing verification semantics.
  expect(await f.reader.movementChain(call, { activityId: source.id, oldPath: "old" })).toEqual(
    await f.reader.movementChain(call, { activityId: source.id }),
  );
});

test.each(["missing", "denied", "revoked", "server", "binding"])(
  "a %s current child cannot be exposed from an own snapshot or readable ancestor",
  async (failure) => {
    const source = candidate(1, { actor_user_id: actorId });
    const f = historyFixture([source]);
    f.nodes.set(`${home}/new/child`, f.node(`${home}/new/child`, "child-id"));
    if (failure === "missing") f.nodes.delete(`${home}/new/child`);
    if (failure === "denied") f.denied.add("new/child");
    if (failure === "revoked") f.setMember(false);
    if (failure === "server") f.setServer("http://replacement.test");
    if (failure === "binding") {
      const original = f.deps.requestContext;
      f.deps.requestContext = async (...args) => {
        const context = await original(...args);
        const authorize = context.readOnlyAuthorized;
        return {
          ...context,
          readOnlyAuthorized: async (...input) => {
            const access = await authorize(...input);
            if (!access.inspection.binding) throw new Error("Expected the fixture binding");
            return { ...access, inspection: { ...access.inspection, binding: { ...access.inspection.binding, id: "replacement" } } };
          },
        };
      };
    }
    // A revoked/old-server snapshot has no approved current display scope; it cannot even initialize a child chain.
    if (failure === "revoked" || failure === "server") {
      await expect(f.reader.movementChain(call, { activityId: source.id, oldPath: "old/child" })).rejects.toMatchObject({ status: 404 });
    } else {
      const chain = await f.reader.movementChain(call, { activityId: source.id, oldPath: "old/child" });
      expect(chain.endpoint).toBeNull();
      expect(chain.certainty).toBe("unavailable");
    }
    expect(f.requests.some((request) => request.includes("resolve"))).toBe(false);
  },
);

test("a descendant request must stay inside the visible before-side's current base-relative scope", async () => {
  for (const oldPath of ["older/child", "unrelated/old/child", "users/alice/old/child"]) {
    const f = historyFixture();
    await expect(f.reader.movementChain(call, { activityId: candidate().id, oldPath })).rejects.toMatchObject({ status: 404 });
    expect(f.database).toEqual([]); // No chain candidate search or endpoint probing for unrelated paths.
    expect(f.authorized).not.toContain(oldPath);
  }
  const file = historyFixture([candidate(1, { directory: false })]);
  await expect(file.reader.movementChain(call, { activityId: candidate().id, oldPath: "old/child" })).rejects.toMatchObject({
    status: 404,
  });
  const hiddenBefore = historyFixture();
  hiddenBefore.nodes.set(`${home}/old`, hiddenBefore.node(`${home}/old`, "stable-a"));
  hiddenBefore.setMember(false);
  await expect(hiddenBefore.reader.movementChain(call, { activityId: candidate().id, oldPath: "old/child" })).rejects.toMatchObject({
    status: 404,
  });
});

test("suffix-derived chains follow later child and ancestor moves without borrowing either identity", async () => {
  const rows = [
    candidate(1, { actor_user_id: actorId }),
    candidate(2, {
      actor_user_id: actorId,
      action: "item.rename",
      path_before: `${home}/new/child.txt`,
      path_after: `${home}/new/renamed.txt`,
      directory: false,
      item_id: "child-id",
      item_after_id: "child-id",
    }),
    candidate(3, { actor_user_id: actorId, path_before: `${home}/new`, path_after: `${home}/final` }),
  ];
  const f = historyFixture(rows);
  f.nodes.delete(`${home}/new`);
  f.nodes.set(`${home}/final`, f.node(`${home}/final`, "stable-a"));
  f.nodes.set(`${home}/final/renamed.txt`, f.node(`${home}/final/renamed.txt`, "child-id", false));
  const chain = await f.reader.movementChain(call, { activityId: rows[0]!.id, oldPath: "old/child.txt" });
  expect(chain.hops.map((hop) => hop.activityId)).toEqual(rows.map((row) => row.id));
  expect(chain.endpoint).toEqual({ baseId: publicBaseId, path: "final/renamed.txt", itemId: null });
  expect(chain.certainty).toBe("probable");
  expect(chain.truncated).toBe(false);
  expect(f.requests.some((request) => request.includes("resolve"))).toBe(false);
});

test.each(["item.copy", "folder.create", "item.trash", "item.purge", "item.move"])(
  "suffix-derived chains stop before a child or ancestor %s lifetime barrier",
  async (action) => {
    for (const ancestor of [false, true]) {
      const source = candidate(1, { actor_user_id: actorId });
      const touched = `${home}/new${ancestor ? "" : "/child"}`;
      const deletion = action === "item.trash" || action === "item.purge";
      const inbound = action === "item.move" || action === "item.copy";
      const barrier = candidate(2, {
        actor_user_id: actorId,
        action,
        path_before: deletion ? touched : inbound ? `${home}/other` : null,
        path_after: deletion ? null : touched,
        directory: true,
        item_id: inbound || deletion ? "other-id" : null,
        item_after_id: deletion ? null : "other-id",
      });
      const f = historyFixture([source, barrier]);
      // A present-day replacement is still readable; permission alone cannot bridge the recorded lifetime gap.
      f.nodes.set(`${home}/new/child`, f.node(`${home}/new/child`, "replacement-id"));
      const chain = await f.reader.movementChain(call, { activityId: source.id, oldPath: "old/child" });
      expect(chain.hops.map((hop) => hop.activityId)).toEqual([source.id]);
      expect(chain.truncated).toBe(true);
      expect(chain.endpoint).toBeNull();
      expect(chain.certainty).toBe("unavailable");
      expect(f.authorized).not.toContain("new/child");
      expect(f.requests.some((request) => request.includes("resolve"))).toBe(false);
    }
  },
);

test("a suffix-derived chain keeps the hop limit and suppresses its endpoint when truncated", async () => {
  const rows = Array.from({ length: 21 }, (_, index) =>
    candidate(index + 1, {
      actor_user_id: actorId,
      path_before: `${home}/${index === 0 ? "old" : `step${index}`}`,
      path_after: `${home}/step${index + 1}`,
    }),
  );
  const f = historyFixture(rows);
  f.nodes.set(`${home}/step21/child`, f.node(`${home}/step21/child`, "child-id"));
  const chain = await f.reader.movementChain(call, { activityId: rows[0]!.id, oldPath: "old/child" });
  expect(chain.hops).toHaveLength(20);
  expect(chain.truncated).toBe(true);
  expect(chain.endpoint).toBeNull();
  expect(f.authorized).not.toContain("step21/child");
});

test("unmanaged descendants remain probable, and invalid old paths fail before history or permission work", async () => {
  const f = historyFixture([candidate(1, { item_id: null, item_after_id: null })]);
  f.setStableIds(false);
  f.nodes.set(`${home}/new/child`, f.node(`${home}/new/child`));
  expect(await f.reader.movementChain(call, { activityId: candidate().id, oldPath: "old/child" })).toMatchObject({
    endpoint: { baseId: publicBaseId, path: "new/child", itemId: null },
    certainty: "probable",
    truncated: false,
  });
  for (const oldPath of ["", "../old/child", "old//child", "old/child/", "old/.filegate/child", "old\\child"]) {
    const invalid = historyFixture();
    await expect(invalid.reader.movementChain(call, { activityId: candidate().id, oldPath })).rejects.toThrow();
    expect(invalid.requests).toEqual([]);
    expect(invalid.authorized).toEqual([]);
    expect(invalid.database).toEqual([]);
  }
});

test("folder history includes readable child uploads while exact file history excludes unrelated items", async () => {
  const uploaded = candidate(1, {
    action: "file.upload",
    path_before: null,
    path_after: `${home}/Docs/report.pdf`,
    directory: false,
    item_id: null,
    item_after_id: null,
  });
  const unrelated = candidate(2, {
    action: "file.upload",
    path_before: null,
    path_after: `${home}/Elsewhere/report.pdf`,
    directory: false,
    item_id: null,
    item_after_id: null,
  });
  const sibling = candidate(3, {
    action: "file.upload",
    path_before: null,
    path_after: `${home}/Docs/other.pdf`,
    directory: false,
    item_id: null,
    item_after_id: null,
  });
  const f = historyFixture([uploaded, unrelated, sibling]);
  for (const path of ["Docs", "Elsewhere", "Docs/report.pdf", "Elsewhere/report.pdf", "Docs/other.pdf"]) {
    f.nodes.set(`${home}/${path}`, f.node(`${home}/${path}`, `id:${path}`, !path.endsWith(".pdf")));
  }
  expect((await f.reader.activity(call, { baseId: publicBaseId, path: "Docs", scope: "folder" })).items.map((item) => item.id)).toEqual([
    sibling.id,
    uploaded.id,
  ]);
  expect(
    (await f.reader.activity(call, { baseId: publicBaseId, path: "Docs/report.pdf", scope: "item" })).items.map((item) => item.id),
  ).toEqual([uploaded.id]);
});

test("administrators retain archive locations outside a local binding's former home", async () => {
  const f = historyFixture([candidate(1, { action: "place.archive", path_after: "archive/alice/file" })]);
  f.setAdmin(true);
  f.setMember(false);
  const result = await f.reader.activity(call);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.after).toMatchObject({ visibility: "full", source: "snapshot", path: "archive/alice/file", relativePath: null });
});
