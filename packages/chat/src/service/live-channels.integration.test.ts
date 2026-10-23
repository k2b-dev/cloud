import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { ServiceAccountSchema } from "@k2b/cloud/contracts";
import type { LiveViewer } from "@k2b/cloud/events";
import { createAccess, type Principal, type RequestActor } from "@k2b/cloud/server";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { messageFixtures, type Person } from "../api/messages.test-fixture";
import { requireConversation } from "./access";
import { chatLiveChannels } from "./live-channels";

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

  test("one batch matches service reads across direct, nested-group, authenticated and public tiers, with people-only delivery", async () => {
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
    // Exercise the shared binding and scope rules independently of the people-only filter.
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
      expect(allowed).toEqual(new Set(viewers.filter((v, i) => v.accessSubject.type === "user" && answers[i]?.ok).map((v) => v.id)));
      expect(await chatLiveChannels.list.authorize(`l:${shortId}`, viewers)).toEqual(allowed);
      return { allowed, answers };
    };
    const direct = await check(chat.shortId);
    expect(direct.allowed).toEqual(
      new Set(
        [owner, read, write, admin, grouped, nested].map((p) => `user:${p.id}`).concat(delegatedViewer.id, boundUser(ownKey, ["read"]).id),
      ),
    );
    const standalonePosition = viewers.findIndex(
      (v) => v.accessSubject.type === "service_account" && v.accessSubject.serviceAccountId === standalone.id,
    );
    expect(direct.answers[standalonePosition]?.ok).toBe(true);
    expect(direct.allowed.has(viewers[standalonePosition]!.id)).toBe(false);
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
    expect(await chatLiveChannels.me.keys({}, keyViewer(standalone, ["read"]))).toBeNull();
    expect(await chatLiveChannels.me.keys({}, boundUser(ownKey, ["read"]))).toBeNull();
    const noScope = boundUser(ownKey, ["openid"]);
    const wrongApp = boundUser({ ...ownKey, appId: "files" }, ["read"]);
    expect(await chatLiveChannels.me.keys({}, noScope)).toBeNull();
    expect(await chatLiveChannels.me.keys({}, wrongApp)).toBeNull();
    expect(await chatLiveChannels.me.authorize(`p:${read.id}`, [noScope, wrongApp])).toEqual(new Set());
  });
});
