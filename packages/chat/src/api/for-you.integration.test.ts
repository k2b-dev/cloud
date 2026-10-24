import { afterEach, expect, type Mock, setDefaultTimeout, spyOn, test } from "bun:test";
import { type AuthContext, createAccess } from "@k2b/cloud/server";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { redis, sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { loadChatView } from "../service";
import { requireConversation } from "../service/access";
import {
  ConversationPageSchema,
  ConversationSchema,
  ForYouPageSchema,
  type Mention,
  MentionCandidatesSchema,
  MessageViewSchema,
  ThreadSchema,
} from "../service/contracts";
import { appendMessage } from "../service/message-store";
import { accessKey, readResource, resourceReaderDependencies } from "../service/resource-access";
import chatApi from ".";
import { messageFixtures, type Person } from "./messages.test-fixture";

setDefaultTimeout(120_000);
const suite = suiteFor("database", "nats", "valkey");
suite("mentions and For you", () => {
  const f = messageFixtures();
  const app = new Hono<AuthContext>().route("/api/chat", chatApi);
  const keys = new Set<string>();
  const extraGrants: string[] = [];
  const extraAccounts: string[] = [];
  let reader: Mock<typeof resourceReaderDependencies.invoke> | undefined;
  afterEach(async () => {
    reader?.mockRestore();
    reader = undefined;
    if (keys.size) await redis.send("DEL", [...keys]);
    keys.clear();
    for (const id of extraGrants.splice(0)) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
    for (const id of extraAccounts.splice(0)) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ${"p:service_account:" + id}`;
      await sql`DELETE FROM audit.events WHERE target_id = ${id} OR actor_uid = ${id} OR metadata->>'serviceAccountId' = ${id}`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
  });
  const api = (person: Person, path: string) =>
    app.request(`https://cloud.example.test/api/chat${path}`, {
      headers: { ...person.headers, "x-forwarded-for": uniqueCallerAddress() },
    });
  const feed = async (person: Person, cursor?: string) => {
    const response = await api(person, `/for-you${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(response.status).toBe(200);
    return ForYouPageSchema.parse(await response.json());
  };
  const send = async (
    person: Person,
    conversation: string,
    input: {
      body: string;
      mentions?: Mention[];
      replyTo?: string;
      thread?: string;
      clientId?: string;
    },
  ) => {
    await f.resetSendLimits([person], conversation);
    return f.request(person.headers, `/${conversation}/messages`, "POST", { clientId: crypto.randomUUID(), ...input });
  };
  const posted = async (...args: Parameters<typeof send>) => {
    const response = await send(...args);
    expect(response.status).toBe(201);
    return MessageViewSchema.parse(await response.json());
  };
  const candidates = async (person: Person, conversation: string, query = "") => {
    const response = await f.request(person.headers, `/${conversation}/mention-candidates${query}`);
    expect(response.status).toBe(200);
    return MentionCandidatesSchema.parse(await response.json());
  };
  const mention = (id: string, start = 0, end = 4, type: "user" | "service_account" = "user"): Mention => ({
    start,
    end,
    principal: { type, id },
  });

  test("validates ranges and membership before committing, preserving idempotent mentions and current names", async () => {
    const owner = await f.person("Owner"),
      mara = await f.person("Mara"),
      outsider = await f.person("Other");
    const chat = await f.fixture(owner, [{ person: mara, permission: "read" }]);
    await f.fixture(outsider);
    const [before] = await sql<{ seq_head: string }[]>`SELECT seq_head FROM chat.conversations WHERE id = ${chat.id}::uuid`;
    expect((await send(owner, chat.shortId, { body: "Mara", mentions: [mention(mara.id, 0, 5)] })).status).toBe(400);
    const [after] = await sql<{ seq_head: string }[]>`SELECT seq_head FROM chat.conversations WHERE id = ${chat.id}::uuid`;
    expect(String(after!.seq_head)).toBe(String(before!.seq_head));
    // Someone who cannot read the chat is not mentioned, but the message still goes out.
    const outsiderMention = await send(owner, chat.shortId, { body: "Mara", mentions: [mention(outsider.id)] });
    expect(outsiderMention.status).toBe(201);
    expect((await outsiderMention.json()).mentions).toEqual([]);
    const input = { clientId: "same-mention", body: "Mara", mentions: [mention(mara.id)] };
    const message = await posted(owner, chat.shortId, input);
    expect(message.mentions).toEqual([{ ...input.mentions[0]!, name: "Mara" }]);
    await sql`UPDATE auth.users SET display_name = 'Mara New' WHERE id = ${mara.id}::uuid`;
    const retry = await send(owner, chat.shortId, { ...input, body: "Different", mentions: [] });
    expect(retry.status).toBe(200);
    const view = MessageViewSchema.parse(await retry.json());
    expect(view.id).toBe(message.id);
    expect(view.body).toBe("Mara");
    expect(view.mentions[0]?.name).toBe("Mara New");
    const [count] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM chat.message_mentions mm JOIN chat.messages m ON m.id = mm.message_id WHERE m.short_id = ${message.id}`;
    expect(count!.n).toBe(1);
    await sql`DELETE FROM auth.users WHERE id = ${mara.id}::uuid`;
    const deleted = MessageViewSchema.parse(await (await f.request(owner.headers, `/${chat.shortId}/messages/${message.id}`)).json());
    expect(deleted.mentions).toEqual([{ ...input.mentions[0]!, name: "Former account" }]);
    await sql`DELETE FROM chat.messages WHERE short_id = ${message.id}`;
    const [remaining] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM chat.message_mentions WHERE principal_type = 'user' AND principal_id = ${mara.id}::uuid`;
    expect(remaining!.n).toBe(0);
  });

  test("ordinary and channel candidates exclude self, match word prefixes, and retain only readable active members", async () => {
    const owner = await f.person("Owner"),
      mara = await f.person("Mara Weber"),
      lena = await f.person("Lena"),
      other = await f.person("Other");
    const chat = await f.fixture(owner, [
      { person: mara, permission: "read" },
      { person: lena, permission: "write" },
    ]);
    await f.fixture(other);
    expect((await candidates(owner, chat.shortId, "?q=we")).items).toEqual([
      { principal: { type: "user", id: mara.id }, name: "Mara Weber", agent: false },
    ]);
    expect((await candidates(owner, chat.shortId)).items.map((item) => item.name)).toEqual(["Lena", "Mara Weber"]);
    const discovery = await createAccess({ principal: { type: "authenticated" }, permission: "read" });
    if (!discovery.ok) throw new Error(discovery.error.message);
    extraGrants.push(discovery.data.id);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${chat.id}::uuid, ${discovery.data.id}::uuid, 'discoverable', 'user', ${owner.id}::uuid)`;
    expect((await candidates(owner, chat.shortId)).items.map((item) => item.name)).toEqual(["Lena", "Mara Weber"]);
    await sql`UPDATE auth.access SET permission = 'none' WHERE id = ${chat.entries.get(mara.id)!}::uuid`;
    expect((await candidates(owner, chat.shortId)).items.map((item) => item.name)).toEqual(["Lena"]);
    expect((await send(owner, chat.shortId, { body: "Mara", mentions: [mention(mara.id)] })).status).toBe(400);
  });

  test("group-only principals become candidates after writing and retain principal identity when grants change", async () => {
    const owner = await f.person("Owner"),
      grouped = await f.person("Group Writer");
    const chat = await f.fixture(owner);
    const group = await f.group([grouped]);
    const grant = await createAccess({ principal: { type: "group", groupId: group }, permission: "write" });
    if (!grant.ok) throw new Error(grant.error.message);
    extraGrants.push(grant.data.id);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${chat.id}::uuid, ${grant.data.id}::uuid, 'member', 'user', ${owner.id}::uuid)`;
    expect((await candidates(owner, chat.shortId)).items).toEqual([]);
    const mentioned = await posted(owner, chat.shortId, { body: "Group Writer", mentions: [mention(grouped.id, 0, 12)] });
    expect(mentioned.mentions).toEqual([{ ...mention(grouped.id, 0, 12), name: "Group Writer" }]);
    expect((await feed(grouped)).items[0]?.message.id).toBe(mentioned.id);
    await posted(grouped, chat.shortId, { body: "Participation" });
    expect((await candidates(owner, chat.shortId)).items).toEqual([
      { principal: { type: "user", id: grouped.id }, name: "Group Writer", agent: false },
    ]);
    await sql`DELETE FROM auth.user_groups_v2 WHERE user_id = ${grouped.id}::uuid AND group_id = ${group}::uuid`;
    expect((await candidates(owner, chat.shortId)).items[0]?.principal.id).toBe(grouped.id);
    expect((await send(owner, chat.shortId, { body: "Group Writer", mentions: [mention(grouped.id, 0, 12)] })).status).toBe(400);
    expect((await feed(grouped)).items).toEqual([]);
    expect((await loadChatView(grouped.context, {})).sidebar.forYouUnread).toBe(0);
  });

  test("candidate searches return at most 20 eligible principals and bound literal word-prefix input", async () => {
    const owner = await f.person("Owner");
    const people: Person[] = [];
    for (let index = 0; index < 22; index++) people.push(await f.person(`Candidate ${String(index).padStart(2, "0")}`));
    const chat = await f.fixture(
      owner,
      people.map((person) => ({ person, permission: "read" as const })),
    );
    await sql`UPDATE auth.users SET account_expires = '2000-01-01T00:00:00Z' WHERE id = ${people[0]!.id}::uuid`;
    const page = await candidates(owner, chat.shortId, "?q=cand");
    expect(page.items).toHaveLength(20);
    expect(page.items.some((person) => person.principal.id === people[0]!.id)).toBeFalse();
    expect((await candidates(owner, chat.shortId, "?q=00")).items).toEqual([]);
    expect((await candidates(owner, chat.shortId, "?q=did")).items).toEqual([]);
    expect((await candidates(owner, chat.shortId, "?q=%2E%2A")).items).toEqual([]);
    expect((await f.request(owner.headers, `/${chat.shortId}/mention-candidates?q=${"x".repeat(101)}`)).status).toBe(400);
    expect((await send(owner, chat.shortId, { body: "Cold", mentions: [mention(people[0]!.id)] })).status).toBe(400);
    expect((await send(owner, chat.shortId, { body: "Cold", mentions: [mention(crypto.randomUUID())] })).status).toBe(400);
  });

  test("candidate service accounts preserve their type and agent flag and follow account eligibility", async () => {
    const owner = await f.person("Owner");
    const chat = await f.fixture(owner);
    const principals = new Map<string, string>();
    for (const [name, kind, resource] of [
      ["Agent", "agent", null],
      ["Service", "standalone", null],
      ["Bound", "resource_bound", "ZZZZZZ"],
    ] as const) {
      const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
        VALUES (${name}, ${kind}, ${resource ? "chat" : null}, ${resource ? "conversation" : null}, ${resource}) RETURNING id`;
      extraAccounts.push(account!.id);
      const grant = await createAccess({ principal: { type: "service_account", serviceAccountId: account!.id }, permission: "read" });
      if (!grant.ok) throw new Error(grant.error.message);
      extraGrants.push(grant.data.id);
      principals.set(name, account!.id);
      await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
        VALUES (${chat.id}::uuid, ${grant.data.id}::uuid, 'member', 'user', ${owner.id}::uuid)`;
    }
    expect((await candidates(owner, chat.shortId)).items).toEqual([
      { principal: { type: "service_account", id: principals.get("Agent")! }, name: "Agent", agent: true },
      { principal: { type: "service_account", id: principals.get("Service")! }, name: "Service", agent: false },
    ]);
    const message = await posted(owner, chat.shortId, {
      body: "Agent",
      mentions: [mention(principals.get("Agent")!, 0, 5, "service_account")],
    });
    expect(message.mentions[0]?.name).toBe("Agent");
    await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${extraAccounts[0]!}::uuid`;
    expect((await candidates(owner, chat.shortId)).items.map((person) => person.name)).toEqual(["Service"]);
    expect(
      (await send(owner, chat.shortId, { body: "Agent", mentions: [mention(principals.get("Agent")!, 0, 5, "service_account")] })).status,
    ).toBe(400);
    expect(
      (await send(owner, chat.shortId, { body: "Bound", mentions: [mention(principals.get("Bound")!, 0, 5, "service_account")] })).status,
    ).toBe(400);
  });

  test("deduplicates mention plus reply, excludes self, tracks read/unread, and includes count in the SSR sidebar", async () => {
    const owner = await f.person("Owner"),
      mara = await f.person("Mara");
    const chat = await f.fixture(owner, [{ person: mara, permission: "write" }]);
    const original = await posted(mara, chat.shortId, { body: "Question" });
    const reply = await posted(owner, chat.shortId, { body: "Answer", replyTo: original.id });
    const both = await posted(owner, chat.shortId, { body: "Mara", replyTo: original.id, mentions: [mention(mara.id)] });
    await posted(mara, chat.shortId, { body: "Mara", mentions: [mention(mara.id)] });
    let page = await feed(mara);
    expect(page.items.map((item) => [item.message.id, item.kind, item.unread])).toEqual([
      [both.id, "mention", true],
      [reply.id, "reply", true],
    ]);
    expect(page.items[0]?.thread).toEqual({ id: "general", name: "General" });
    expect((await loadChatView(mara.context, {})).sidebar.forYouUnread).toBe(2);
    const sidebar = ConversationPageSchema.parse(await (await f.request(mara.headers, "")).json());
    expect(sidebar.forYouUnread).toBe(2);
    const read = await f.request(mara.headers, `/${chat.shortId}/read`, "POST", { seq: both.seq });
    expect(read.status).toBe(200);
    page = await feed(mara);
    expect(page.items.every((item) => !item.unread)).toBeTrue();
    expect((await loadChatView(mara.context, {})).sidebar.forYouUnread).toBe(0);
    expect((await f.request(mara.headers, `/${chat.shortId}/unread`, "POST", { message: both.id })).status).toBe(200);
    expect((await feed(mara)).items.find((item) => item.message.id === both.id)?.unread).toBeTrue();
    await sql`UPDATE auth.access SET permission = 'none' WHERE id = ${chat.entries.get(mara.id)!}::uuid`;
    expect((await feed(mara)).items).toEqual([]);
    expect((await loadChatView(mara.context, {})).sidebar.forYouUnread).toBe(0);
  });

  test("named-thread mentions use the named thread's read position independently of General", async () => {
    const owner = await f.person("Owner"),
      mara = await f.person("Mara");
    const chat = await f.fixture(owner, [{ person: mara, permission: "write" }]);
    const response = await f.request(owner.headers, `/${chat.shortId}/threads`, "POST", { name: "Delivery" });
    expect(response.status).toBe(201);
    const thread = ThreadSchema.parse(await response.json());
    const message = await posted(owner, chat.shortId, { body: "Mara", thread: thread.id, mentions: [mention(mara.id)] });
    expect((await feed(mara)).items[0]).toMatchObject({ thread: { id: thread.id, name: "Delivery" }, unread: true });
    expect((await f.request(mara.headers, `/${chat.shortId}/read`, "POST", { seq: message.seq, thread: "general" })).status).toBe(200);
    expect((await feed(mara)).items[0]?.unread).toBeTrue();
    expect((await f.request(mara.headers, `/${chat.shortId}/read`, "POST", { seq: message.seq, thread: thread.id })).status).toBe(200);
    expect((await feed(mara)).items[0]?.unread).toBeFalse();
  });

  test("empty inaccessible candidate pages still advance to older readable messages", async () => {
    const owner = await f.person("Owner"),
      mara = await f.person("Mara");
    const hidden = await f.fixture(owner, [{ person: mara, permission: "write" }]);
    const visible = await f.fixture(owner, [{ person: mara, permission: "write" }]);
    const message = await posted(owner, visible.shortId, { body: "Mara", mentions: [mention(mara.id)] });
    await sql`UPDATE chat.messages SET created_at = '2026-10-24T12:00:00Z' WHERE short_id = ${message.id}`;
    await sql.begin(async (db) => {
      await db`SELECT id FROM chat.conversations WHERE id = ${hidden.id}::uuid FOR UPDATE`;
      const allowed = await requireConversation({ ...owner.context, conversationId: hidden.shortId, required: "write" }, db);
      if (!allowed.ok) throw new Error(allowed.error.message);
      for (let index = 0; index < 31; index++)
        await appendMessage(db, allowed.data, owner.context, {
          kind: "text",
          clientId: `hidden-${index}`,
          body: "Mara",
          mentions: [mention(mara.id)],
        });
      await db`UPDATE chat.messages SET created_at = '2026-10-24T12:00:01Z' WHERE conversation_id = ${hidden.id}::uuid`;
    });
    await sql`UPDATE auth.access SET permission = 'none' WHERE id = ${hidden.entries.get(mara.id)!}::uuid`;
    const first = await feed(mara);
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    const second = await feed(mara, first.nextCursor!);
    expect(second.items.map((item) => item.message.id)).toEqual([message.id]);
    expect(second.nextCursor).toBeNull();
    expect((await loadChatView(mara.context, {})).sidebar.forYouUnread).toBe(1);
  });

  test("pages equal timestamps without duplicates, enforces cursor bounds, and caps unread count at 99", async () => {
    const owner = await f.person("Owner"),
      mara = await f.person("Mara");
    const chat = await f.fixture(owner, [{ person: mara, permission: "write" }]);
    await sql.begin(async (db) => {
      await db`SELECT id FROM chat.conversations WHERE id = ${chat.id}::uuid FOR UPDATE`;
      const allowed = await requireConversation({ ...owner.context, conversationId: chat.shortId, required: "write" }, db);
      if (!allowed.ok) throw new Error(allowed.error.message);
      for (let index = 0; index < 101; index++)
        await appendMessage(db, allowed.data, owner.context, {
          kind: "text",
          clientId: `paged-${index}`,
          body: "Mara",
          mentions: [mention(mara.id)],
        });
      await db`UPDATE chat.messages SET created_at = '2026-10-24T12:00:00.123456Z' WHERE conversation_id = ${chat.id}::uuid`;
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await feed(mara, cursor);
      expect(page.items.length).toBeLessThanOrEqual(30);
      seen.push(...page.items.map((item) => item.message.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(101);
    expect(new Set(seen).size).toBe(101);
    expect((await loadChatView(mara.context, {})).sidebar.forYouUnread).toBe(99);
    expect((await api(mara, `/for-you?cursor=${"x".repeat(257)}`)).status).toBe(400);
    expect((await api(mara, "/for-you?cursor=not-a-cursor")).status).toBe(400);
  });

  test("publishes contentless personal updates only for the mentioned or quoted author, atomically with the message", async () => {
    const owner = await f.person("Owner"),
      mara = await f.person("Mara"),
      lena = await f.person("Lena");
    const chat = await f.fixture(owner, [
      { person: mara, permission: "write" },
      { person: lena, permission: "write" },
    ]);
    const original = await posted(lena, chat.shortId, { body: "Question" });
    const message = await posted(owner, chat.shortId, {
      body: "Mara",
      replyTo: original.id,
      mentions: [mention(mara.id)],
    });
    const rows = await sql<
      { ordering_key: string; data: unknown }[]
    >`SELECT ordering_key, payload->'d' AS data FROM events.outbox WHERE app_id = 'chat'
      AND ordering_key IN (${"p:" + owner.id}, ${"p:" + mara.id}, ${"p:" + lena.id}) AND payload->'d'->>'type' = 'for-you'`;
    expect(rows.map((row) => row.ordering_key).sort()).toEqual([`p:${mara.id}`, `p:${lena.id}`].sort());
    expect(rows.every((row) => JSON.stringify(row.data) === JSON.stringify({ type: "for-you" }))).toBeTrue();
    const [live] = await sql<{ message: unknown }[]>`SELECT payload->'d'->'message' AS message FROM events.outbox WHERE app_id = 'chat'
      AND ordering_key = ${"c:" + chat.shortId} AND payload->'d'->'message'->>'id' = ${message.id}`;
    expect(MessageViewSchema.omit({ systemText: true, reactions: true }).parse(live!.message).mentions).toEqual(message.mentions);
    const [countBefore] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM events.outbox WHERE ordering_key = ${"p:" + mara.id} AND app_id = 'chat'`;
    await f.request(mara.headers, `/${chat.shortId}/read`, "POST", { seq: message.seq });
    const [countAfter] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM events.outbox WHERE ordering_key = ${"p:" + mara.id} AND app_id = 'chat'`;
    expect(countAfter!.n).toBeGreaterThan(countBefore!.n);
  });

  for (const [containerType, itemType] of [
    ["spaces.space", "spaces.item"],
    ["notebooks.notebook", "notebooks.note"],
  ] as const)
    test(`${containerType}: system mentions accept cold principals without grants; For you rechecks readers`, async () => {
      const owner = await f.person("Owner"),
        mara = await f.person("Mara"),
        denied = await f.person("Denied");
      const space = testShortId(),
        item = testShortId();
      let denyMara = false;
      reader = spyOn(resourceReaderDependencies, "invoke").mockImplementation(async (_app, capability, _input, caller) => {
        if (capability === `${containerType.split(".")[1]}.read`)
          return { data: { id: space, name: "Project", permission: "write" }, links: [{ rel: "open", href: `/app/spaces/${space}` }] };
        if (
          capability === `${itemType.split(".")[1]}.read` &&
          caller.cookie !== denied.headers.cookie &&
          !(denyMara && caller.cookie === mara.headers.cookie)
        )
          return {
            data:
              itemType === "spaces.item"
                ? { id: item, title: "Task current title", kind: "task", spaceId: space }
                : { id: item, title: "Task current title", notebookId: space },
            links: [{ rel: "open", href: `/app/spaces/${space}/${item}` }],
          };
        return null;
      });
      for (const person of [owner, mara, denied])
        for (const ref of [
          { type: containerType, id: space },
          { type: itemType, id: item },
        ]) {
          keys.add(accessKey(`user:${person.id}`, ref));
          await readResource(person.context, ref);
        }
      const response = await app.request(`https://cloud.example.test/api/chat/system-chats/${containerType}/${space}/open`, {
        method: "POST",
        headers: { ...owner.headers, "x-forwarded-for": uniqueCallerAddress() },
      });
      expect(response.status).toBe(200);
      const chat = ConversationSchema.parse(await response.json());
      f.trackChat(chat.id);
      const threadResponse = await f.request(owner.headers, `/${chat.id}/threads/for-resource`, "POST", {
        ref: { type: itemType, id: item },
      });
      expect(threadResponse.status).toBe(200);
      const thread = ThreadSchema.parse(await threadResponse.json());
      await posted(mara, chat.id, { body: "General participation" });
      await posted(denied, chat.id, { body: "General participation" });
      expect((await candidates(owner, chat.id, `?thread=${thread.id}`)).items.map((person) => person.name)).toEqual(["Denied", "Mara"]);
      // Remove target decisions: send must not depend on another principal's reader cache.
      for (const person of [mara, denied])
        for (const ref of [
          { type: containerType, id: space },
          { type: itemType, id: item },
        ])
          await redis.del(accessKey(`user:${person.id}`, ref));
      expect((await candidates(owner, chat.id, `?thread=${thread.id}`)).items.map((person) => person.name)).toEqual(["Denied", "Mara"]);
      const cold = await f.person("Cold");
      for (const ref of [
        { type: containerType, id: space },
        { type: itemType, id: item },
      ])
        keys.add(accessKey(`user:${cold.id}`, ref));
      const callsBefore = reader.mock.calls.length;
      const firstMention = await posted(owner, chat.id, { body: "Cold", thread: thread.id, mentions: [mention(cold.id)] });
      expect(reader.mock.calls.slice(callsBefore).every((call) => call[3].cookie === owner.headers.cookie)).toBeTrue();
      expect((await candidates(owner, chat.id)).items.some((person) => person.principal.id === cold.id)).toBeFalse();
      expect((await feed(cold)).items[0]).toMatchObject({ message: { id: firstMention.id }, unread: true });
      const mentionedDenied = await send(owner, chat.id, {
        body: "Nope",
        thread: thread.id,
        mentions: [mention(denied.id)],
      });
      expect(mentionedDenied.status).toBe(201);
      expect((await feed(denied)).items).toEqual([]);
      expect((await loadChatView(denied.context, {})).sidebar.forYouUnread).toBe(0);
      const message = await posted(owner, chat.id, {
        body: "Mara",
        thread: thread.id,
        mentions: [mention(mara.id)],
      });
      const inactive = await f.person("Inactive");
      await sql`UPDATE auth.users SET account_expires = '2000-01-01T00:00:00Z' WHERE id = ${inactive.id}::uuid`;
      expect((await send(owner, chat.id, { body: "Target", mentions: [mention(inactive.id, 0, 6)] })).status).toBe(400);
      expect((await send(owner, chat.id, { body: "Target", mentions: [mention(crypto.randomUUID(), 0, 6)] })).status).toBe(400);
      for (const [kind, status, resource, expected] of [
        ["agent", "active", null, 201],
        ["agent", "disabled", null, 400],
        ["user_delegated", "active", null, 400],
        ["resource_bound", "active", "ZZZZZZ", 400],
        ["resource_bound", "active", chat.id, 201],
      ] as const) {
        const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts
          (name, kind, status, delegated_user_id, app_id, resource_type, resource_id)
          VALUES ('Target', ${kind}, ${status}, ${kind === "user_delegated" ? owner.id : null}::uuid,
            ${resource ? "chat" : null}, ${resource ? "conversation" : null}, ${resource}) RETURNING id`;
        extraAccounts.push(account!.id);
        expect(
          (await send(owner, chat.id, { body: "Target", thread: thread.id, mentions: [mention(account!.id, 0, 6, "service_account")] }))
            .status,
        ).toBe(expected);
        if (kind === "agent" && status === "active") {
          keys.add(accessKey(`service_account:${account!.id}:scopes=openid,read,write`, { type: containerType, id: space }));
          const token = await serviceAccountCredentials.createApiToken({
            serviceAccountId: account!.id,
            name: "mention candidate",
            scopes: ["openid", "read", "write"],
          });
          if (!token.ok) throw new Error(token.error.message);
          const authored = await f.request({ authorization: `Bearer ${token.data.token}` }, `/${chat.id}/messages`, "POST", {
            clientId: "agent-author",
            body: "Participation",
          });
          expect(authored.status).toBe(201);
          expect((await candidates(owner, chat.id)).items).toContainEqual({
            principal: { type: "service_account", id: account!.id },
            name: "Target",
            agent: true,
          });
        }
      }
      let page = await feed(mara);
      expect(page.items[0]).toMatchObject({
        conversation: { id: chat.id, title: "Project", kind: "system" },
        thread: { id: thread.id, name: "Task current title" },
        message: { id: message.id },
        unread: true,
      });
      expect((await f.request(mara.headers, `/${chat.id}/read`, "POST", { seq: message.seq, thread: thread.id })).status).toBe(200);
      expect((await feed(mara)).items[0]?.unread).toBeFalse();
      expect((await f.request(mara.headers, `/${chat.id}/unread`, "POST", { message: message.id })).status).toBe(200);
      expect((await loadChatView(mara.context, {})).sidebar.forYouUnread).toBe(1);
      denyMara = true;
      await redis.del(accessKey(`user:${mara.id}`, { type: itemType, id: item }));
      page = await feed(mara);
      expect(page.items).toEqual([]);
      expect((await loadChatView(mara.context, {})).sidebar.forYouUnread).toBe(0);
    });
});
