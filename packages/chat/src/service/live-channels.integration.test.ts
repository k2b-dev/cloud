import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { redis, sql } from "@k2b/cloud";
import { ServiceAccountSchema } from "@k2b/cloud/contracts";
import type { LiveViewer } from "@k2b/cloud/events";
import { createLiveEngine, createMemoryLiveTopic } from "@k2b/cloud/events/testing";
import { createAccess, type Principal, type RequestActor } from "@k2b/cloud/server";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import "../../../../scripts/fixtures/authorization-preload";
import { messageFixtures, type Person } from "../api/messages.test-fixture";
import { requireConversation } from "./access";
import { mockDiscussionCatalog, providerApp } from "./discussions.test-fixture";
import { chatLiveChannels } from "./live-channels";
import { accessKey, authorizationKey, readResource, resourceReaderDependencies } from "./resource-access";

setDefaultTimeout(30_000);
const suite = suiteFor("database", "nats", "valkey");
suite("Chat batched live authorization", () => {
  const f = messageFixtures();
  const groups: string[] = [],
    accounts: string[] = [],
    grants: string[] = [];
  const group = async () => {
    const name = `chat-live-${crypto.randomUUID()}`;
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.groups (cn, provider, name) VALUES (${name}, 'local', ${name}) RETURNING id`;
    if (!row) throw new Error("Missing group");
    groups.push(row.id);
    return row.id;
  };
  const grant = async (chatId: string, authorId: string, principal: Principal, permission: "read" | "write" | "admin") => {
    const result = await createAccess({ principal, permission });
    if (!result.ok) throw new Error(result.error.message);
    grants.push(result.data.id);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${chatId}::uuid, ${result.data.id}::uuid, 'discoverable', 'user', ${authorId}::uuid)`;
  };
  const account = async (
    kind: "standalone" | "resource_bound" | "user_delegated",
    resourceId: string | null = null,
    userId: string | null = null,
  ) => {
    const id = crypto.randomUUID();
    accounts.push(id);
    await sql`INSERT INTO auth.service_accounts (id, name, kind, app_id, resource_type, resource_id, delegated_user_id)
      VALUES (${id}::uuid, 'Chat live test', ${kind}, ${kind === "resource_bound" ? "chat" : null}, ${kind === "resource_bound" ? "conversation" : null}, ${resourceId}, ${userId}::uuid)`;
    return ServiceAccountSchema.parse({
      id,
      name: "Chat live test",
      kind,
      status: "active",
      appId: kind === "resource_bound" ? "chat" : null,
      resourceType: kind === "resource_bound" ? "conversation" : null,
      resourceId,
      delegatedUserId: userId,
      createdBy: null,
      createdAt: new Date().toISOString(),
    });
  };
  const viewer = (person: Person): LiveViewer => ({
    id: `user:${person.id}`,
    actor: person.context.actor,
    accessSubject: person.context.accessSubject,
    scopes: [],
  });
  afterAll(async () => {
    for (const id of grants) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
    for (const id of accounts) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    for (const id of groups) {
      await sql`DELETE FROM auth.group_groups_v2 WHERE parent_group_id = ${id}::uuid OR child_group_id = ${id}::uuid`;
      await sql`DELETE FROM auth.user_groups_v2 WHERE group_id = ${id}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id = ${id}::uuid`;
    }
  });

  test("one batch matches service reads across direct, nested-group, authenticated and public tiers, for every account kind", async () => {
    const owner = await f.person("Owner"),
      read = await f.person("Read"),
      write = await f.person("Write"),
      admin = await f.person("Admin");
    const grouped = await f.person("Group"),
      nested = await f.person("Nested"),
      removed = await f.person("Removed"),
      outside = await f.person("Outside");
    const people = [owner, read, write, admin, grouped, nested, removed, outside];
    const chat = await f.fixture(owner, [
      { person: read, permission: "read" },
      { person: write, permission: "write" },
      { person: admin, permission: "admin" },
    ]);
    const parent = await group(),
      child = await group();
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parent}::uuid, ${child}::uuid)`;
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${grouped.id}::uuid, ${parent}::uuid), (${nested.id}::uuid, ${child}::uuid), (${removed.id}::uuid, ${parent}::uuid)`;
    await sql`DELETE FROM auth.user_groups_v2 WHERE user_id = ${removed.id}::uuid AND group_id = ${parent}::uuid`;
    await grant(chat.id, owner.id, { type: "group", groupId: parent }, "read");
    const standalone = await account("standalone"),
      ownKey = await account("resource_bound", chat.shortId),
      otherKey = await account("resource_bound", "other1"),
      delegated = await account("user_delegated", null, read.id);
    for (const key of [standalone, ownKey, otherKey])
      await grant(chat.id, owner.id, { type: "service_account", serviceAccountId: key.id }, "admin");
    const keyViewer = (key: typeof standalone, scopes: string[]): LiveViewer => ({
      id: `service_account:${key.id}:${scopes.join(",")}`,
      actor: { kind: "service_account", serviceAccount: key, delegatedUser: null, scopes },
      accessSubject: { type: "service_account", serviceAccountId: key.id },
      scopes,
    });
    const delegatedActor: RequestActor = {
      kind: "service_account",
      serviceAccount: delegated,
      delegatedUser: read.context.actor.kind === "user" ? read.context.actor.user : null,
      scopes: [],
    };
    const delegatedViewer: LiveViewer = {
      id: `user:${read.id}:delegated`,
      actor: delegatedActor,
      accessSubject: { type: "user", userId: read.id, delegatedByServiceAccountId: delegated.id },
      scopes: [],
    };
    // Exercise the shared binding and scope rules for bound credentials.
    const boundUser = (key: typeof ownKey, scopes: string[]): LiveViewer => ({
      ...viewer(read),
      id: `user:${read.id}:${key.id}:${scopes.join(",")}`,
      actor: { kind: "service_account", serviceAccount: key, delegatedUser: null, scopes },
      scopes,
    });
    const viewers = [
      ...people.map(viewer),
      delegatedViewer,
      keyViewer(standalone, ["read"]),
      keyViewer(ownKey, ["read"]),
      keyViewer(otherKey, ["read"]),
      boundUser(ownKey, ["read"]),
      boundUser(otherKey, ["read"]),
      boundUser(ownKey, []),
    ];
    const check = async (shortId: string) => {
      const answers = await Promise.all(
        viewers.map((v) =>
          requireConversation({ actor: v.actor, accessSubject: v.accessSubject, conversationId: shortId, required: "read" }),
        ),
      );
      const allowed = await chatLiveChannels.conversation.authorize(`c:${shortId}`, viewers);
      expect(allowed).toEqual(new Set(viewers.filter((v, i) => answers[i]?.ok).map((v) => v.id)));
      expect(await chatLiveChannels.list.authorize(`l:${shortId}`, viewers)).toEqual(allowed);
      return { allowed, answers };
    };
    const direct = await check(chat.shortId);
    expect(direct.allowed).toEqual(
      new Set(
        [owner, read, write, admin, grouped, nested]
          .map((p) => `user:${p.id}`)
          .concat(delegatedViewer.id, boundUser(ownKey, ["read"]).id, keyViewer(standalone, ["read"]).id, keyViewer(ownKey, ["read"]).id),
      ),
    );
    const standalonePosition = viewers.findIndex(
      (v) => v.accessSubject.type === "service_account" && v.accessSubject.serviceAccountId === standalone.id,
    );
    expect(direct.answers[standalonePosition]?.ok).toBe(true);
    expect(direct.allowed.has(viewers[standalonePosition]!.id)).toBe(true);
    expect(direct.answers[viewers.findIndex((v) => v.id === keyViewer(ownKey, ["read"]).id)]?.ok).toBe(true);
    expect(direct.answers[viewers.findIndex((v) => v.id === keyViewer(otherKey, ["read"]).id)]?.ok).toBe(false);
    for (const principal of [{ type: "authenticated" }, { type: "public" }] as const) {
      const shared = await f.fixture(owner);
      await grant(shared.id, owner.id, principal, "read");
      const result = await check(shared.shortId);
      for (const person of people) expect(result.allowed.has(`user:${person.id}`)).toBe(true);
      // Discoverability grants authorize reads but do not put chats in the sidebar.
      expect(await chatLiveChannels.list.keys({}, viewer(outside))).not.toContain(`l:${shared.shortId}`);
    }
    expect(await chatLiveChannels.conversation.authorize("c:absent", viewers)).toEqual(new Set());
    expect(await chatLiveChannels.conversation.keys({ conversation: "absent" })).toEqual(["c:absent"]);
    expect(await chatLiveChannels.me.authorize(`p:${read.id}`, viewers)).toEqual(new Set([viewer(read).id, delegatedViewer.id]));
    expect(await chatLiveChannels.me.keys({}, keyViewer(standalone, ["read"]))).toEqual([`p:service_account:${standalone.id}`]);
    const serviceReader = keyViewer(standalone, ["read"]);
    const serviceWithoutRead = keyViewer(standalone, ["openid"]);
    expect(await chatLiveChannels.me.keys({}, serviceWithoutRead)).toEqual([]);
    expect(await chatLiveChannels.me.authorize(`p:service_account:${standalone.id}`, [serviceReader, serviceWithoutRead])).toEqual(
      new Set([serviceReader.id]),
    );
    expect(await chatLiveChannels.me.keys({}, keyViewer(ownKey, ["read"]))).toEqual([]);
    const foreignBound = keyViewer({ ...ownKey, appId: "files" }, ["read"]);
    expect(await chatLiveChannels.me.keys({}, foreignBound)).toEqual([]);
    expect(await chatLiveChannels.me.authorize(`p:service_account:${ownKey.id}`, [foreignBound])).toEqual(new Set());
  });

  test("an expired discussion authority never waits for its owner before other keys are delivered", async () => {
    const owner = await f.person("Slow owner reader");
    const chat = await f.fixture(owner);
    const ref = { type: "inventory.collection", id: testShortId() };
    await sql`UPDATE chat.conversations SET kind = 'system', resource_type = ${ref.type}, resource_id = ${ref.id}
      WHERE id = ${chat.id}::uuid`;
    const catalog = mockDiscussionCatalog([providerApp("inventory")]);
    const release = Promise.withResolvers<void>();
    let slow = false;
    let ownerCalls = 0;
    const invoke = spyOn(resourceReaderDependencies, "invoke").mockImplementation(async () => {
      if (slow) {
        ownerCalls++;
        await release.promise;
      }
      return { data: { view: { title: "Slow resource", permission: "read" } } };
    });
    const topic = createMemoryLiveTopic();
    let changed: (subject?: { userId?: string }) => void = () => {};
    let keyReads = 0;
    const engine = createLiveEngine({
      appId: "chat",
      topic: () => topic,
      channels: {
        ...chatLiveChannels,
        conversation: {
          ...chatLiveChannels.conversation,
          keys: async (scope: { conversation: string }) => {
            const keys = await chatLiveChannels.conversation.keys(scope);
            keyReads++;
            return keys;
          },
        },
      },
      subscribeAccess: (callback) => {
        changed = callback;
        return () => {};
      },
    });
    const frames: { t: string; id?: string; data?: unknown }[] = [];
    const closes: number[] = [];
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 2_000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error("Unrelated delivery waited for the owner");
        await Bun.sleep(5);
      }
    };
    try {
      await readResource(owner.context, ref);
      const who = viewer(owner);
      const connection = engine.open(
        {
          send: (frame) => frames.push(JSON.parse(frame)),
          close: (code) => {
            if (code) closes.push(code);
          },
          getBufferedAmount: () => 0,
        },
        who,
        async () => who,
      );
      connection.message(JSON.stringify({ t: "sub", id: "chat", channel: "conversation", scope: { conversation: chat.shortId } }));
      connection.message(JSON.stringify({ t: "sub", id: "personal", channel: "me", scope: {} }));
      await until(() => frames.filter((frame) => frame.t === "ready").length === 2);
      slow = true;
      const previous = keyReads;
      changed({ userId: owner.id });
      await until(() => keyReads === previous + 1);
      topic.publish({ v: 1, k: `c:${chat.shortId}`, d: { expired: true } });
      topic.publish({ v: 1, k: `p:${owner.id}`, d: { unrelated: true } });
      await until(() => frames.some((frame) => frame.id === "personal" && frame.t === "event"));
      expect(frames.some((frame) => frame.id === "chat" && frame.t === "resync")).toBe(true);
      expect(frames.some((frame) => frame.id === "chat" && frame.t === "event")).toBe(false);
      expect(ownerCalls).toBe(0);
      expect(closes).toEqual([]);
    } finally {
      release.resolve();
      engine.stop();
      invoke.mockRestore();
      catalog.mockRestore();
      const key = authorizationKey(viewer(owner).id, ref);
      await redis.del(key, `${key}:generation`, accessKey(viewer(owner).id, ref));
    }
  });

  test("SQL budget: identity hints and expired delivery decisions never call resource owners", async () => {
    const owner = await f.person("Budget owner"),
      outside = await f.person("Budget outside");
    const chat = await f.fixture(owner);
    const container = { type: "inventory.collection", id: testShortId() };
    const items = Array.from({ length: 3 }, () => ({ type: "inventory.item", id: testShortId(), thread: testShortId() }));
    await sql`UPDATE chat.conversations SET kind = 'system', resource_type = ${container.type}, resource_id = ${container.id}
      WHERE id = ${chat.id}::uuid`;
    for (const item of items)
      await sql`INSERT INTO chat.threads
      (short_id, conversation_id, name, created_by_type, created_by_id, resource_type, resource_id)
      VALUES (${item.thread}, ${chat.id}::uuid, 'Budget thread', 'user', ${owner.id}::uuid, ${item.type}, ${item.id})`;
    const catalog = mockDiscussionCatalog([providerApp("inventory")]);
    let denied = false;
    const calls: string[] = [];
    const invoke = spyOn(resourceReaderDependencies, "invoke").mockImplementation(async (_app, capability, input) => {
      calls.push(`${capability}:${input.id}`);
      if (denied) return null;
      return {
        data: {
          view: {
            title: "Budget resource",
            permission: "read",
            ...(capability === "item.read" ? { container: { ref: container, title: "Budget container" } } : {}),
          },
        },
      };
    });
    const topic = createMemoryLiveTopic();
    let changed: (subject?: { userId?: string }) => void = () => {};
    let keyReads = 0;
    const channel = {
      ...chatLiveChannels.conversation,
      keys: async (scope: { conversation: string }) => {
        const keys = await chatLiveChannels.conversation.keys(scope);
        keyReads++;
        return keys;
      },
    };
    const engine = createLiveEngine({
      appId: "chat",
      topic: () => topic,
      channels: { conversation: channel },
      subscribeAccess: (callback) => {
        changed = callback;
        return () => {};
      },
    });
    const frames: Array<Array<{ t: string; data?: unknown }>> = [];
    const closes: number[] = [];
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 2_000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error("Budget condition not reached");
        await Bun.sleep(5);
      }
    };
    const meter = await meterSql();
    try {
      for (const person of [owner, outside])
        for (const ref of [container, ...items]) await readResource(person.context, { type: ref.type, id: ref.id });
      calls.length = 0;
      const connect = async (person: Person) => {
        const output: (typeof frames)[number] = [];
        frames.push(output);
        const who = viewer(person);
        const connection = engine.open(
          {
            send: (frame) => output.push(JSON.parse(frame)),
            close: (code) => {
              if (code) closes.push(code);
            },
            getBufferedAmount: () => 0,
          },
          who,
          async () => {
            await sql`SELECT 1`;
            return who;
          },
        );
        connection.message(JSON.stringify({ t: "sub", id: "chat", channel: "conversation", scope: { conversation: chat.shortId } }));
        await until(() => output.some((frame) => frame.t === "ready"));
      };
      const setupCounts: number[] = [];
      for (const person of [owner, owner, outside]) {
        const setup = await meter.during(() => connect(person));
        setupCounts.push(setup.length);
        console.log("SQL BUDGET Chat setup", setup.length);
      }
      expect(setupCounts).toEqual([9, 2, 9]);
      expect(calls).toEqual([]);
      const beforeGlobal = keyReads;
      const globalAccess = await meter.during(async () => {
        changed();
        await until(() => keyReads === beforeGlobal + 3);
        await Bun.sleep(5);
      });
      expect(globalAccess).toHaveLength(27); // Nine local statements per affected connection; no owner fan-out.
      expect(calls).toEqual([]);
      // Ordinary reads can restore authority independently of the live engine.
      for (const person of [owner, outside])
        for (const ref of [container, ...items]) await readResource(person.context, { type: ref.type, id: ref.id });
      calls.length = 0;
      const previous = keyReads;
      const access = await meter.during(async () => {
        changed({ userId: owner.id });
        await until(() => keyReads === previous + 2);
        await Bun.sleep(5);
      });
      expect(access).toHaveLength(18); // Two affected tabs: credential 1, four key decisions 7, collection 1.
      expect(calls).toEqual([]);
      const unrelated = await meter.during(async () => {
        changed({ userId: "00000000-0000-4000-8000-000000000000" });
        await Bun.sleep(5);
      });
      expect(unrelated).toHaveLength(0);
      const delivery = await meter.during(async () => {
        for (const item of items.slice(0, 2)) topic.publish({ v: 1, k: `t:${chat.shortId}:${item.thread}`, d: { active: true } });
        await until(() => frames[2]!.filter((frame) => frame.t === "event").length === 2);
      });
      expect(delivery).toHaveLength(4);
      expect(frames.slice(0, 2).every((output) => output.some((frame) => frame.t === "resync"))).toBe(true);
      expect(frames.slice(0, 2).every((output) => !output.some((frame) => frame.t === "event"))).toBe(true);
      expect(calls).toEqual([]); // Cold keys expire; owner work belongs to HTTP renewal.
      const warm = await meter.during(async () => {
        topic.publish({ v: 1, k: `t:${chat.shortId}:${items[0]!.thread}`, d: { warm: true } });
        await until(() => frames[2]!.filter((frame) => frame.t === "event").length === 3);
      });
      expect(warm).toHaveLength(0);
      calls.length = 0;
      denied = true;
      const beforeDenial = keyReads;
      changed({ userId: outside.id });
      await until(() => keyReads === beforeDenial + 1);
      expect(calls).toEqual([]);
      topic.publish({ v: 1, k: `t:${chat.shortId}:${items[0]!.thread}`, d: { denied: true } });
      await until(() => frames[2]!.some((frame) => frame.t === "resync"));
      expect(frames.map((output) => output.filter((frame) => frame.t === "event").length)).toEqual([0, 0, 3]);
      expect(calls).toEqual([]);
      expect(closes).toEqual([]);
      console.log(
        "SQL BUDGET Chat identity",
        access.length,
        "global",
        globalAccess.length,
        "unrelated",
        unrelated.length,
        "active",
        delivery.length,
        "warm",
        warm.length,
      );
    } finally {
      engine.stop();
      await meter.close();
      invoke.mockRestore();
      catalog.mockRestore();
      for (const person of [owner, outside])
        for (const ref of [container, ...items]) {
          const key = authorizationKey(viewer(person).id, ref);
          await redis.del(key, `${key}:generation`, accessKey(viewer(person).id, ref));
        }
    }
  });
});
