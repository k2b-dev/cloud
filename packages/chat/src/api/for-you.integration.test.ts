import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { type AuthContext, createAccess } from "@k2b/cloud/server";
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
  let reader: ReturnType<typeof spyOn> | undefined;
  afterEach(async () => {
    reader?.mockRestore();
    reader = undefined;
    if (keys.size) await redis.send("DEL", [...keys]);
    keys.clear();
    for (const id of extraGrants.splice(0)) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
    for (const id of extraAccounts.splice(0)) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ${"p:service_account:" + id}`;
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
      mentions?: { start: number; end: number; accessId: string }[];
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
  const mention = (accessId: string, start = 0, end = 4) => ({ start, end, accessId });

  test("validates ranges and membership before committing, preserving idempotent mentions and current names", async () => {
    const owner = await f.person("Owner"),
      mara = await f.person("Mara"),
      outsider = await f.person("Other");
    const chat = await f.fixture(owner, [{ person: mara, permission: "read" }]);
    const foreign = await f.fixture(outsider);
    const [before] = await sql<{ seq_head: string }[]>`SELECT seq_head FROM chat.conversations WHERE id = ${chat.id}::uuid`;
    const invalid = await send(owner, chat.shortId, { body: "Mara", mentions: [mention(foreign.entries.get(outsider.id)!)] });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "INVALID_MENTION" });
    expect((await send(owner, chat.shortId, { body: "Mara", mentions: [mention(chat.entries.get(mara.id)!, 0, 5)] })).status).toBe(400);
    const [after] = await sql<{ seq_head: string }[]>`SELECT seq_head FROM chat.conversations WHERE id = ${chat.id}::uuid`;
    expect(String(after!.seq_head)).toBe(String(before!.seq_head));
    const input = { clientId: "same-mention", body: "Mara", mentions: [mention(chat.entries.get(mara.id)!)] };
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
    >`SELECT count(*)::int AS n FROM chat.message_mentions WHERE access_id = ${input.mentions[0]!.accessId}::uuid`;
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
      { accessId: chat.entries.get(mara.id)!, type: "user", name: "Mara Weber", agent: false },
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
    expect((await send(owner, chat.shortId, { body: "Mara", mentions: [mention(chat.entries.get(mara.id)!)] })).status).toBe(400);
  });

  test("candidate service accounts preserve their type and agent flag and follow account eligibility", async () => {
    const owner = await f.person("Owner");
    const chat = await f.fixture(owner);
    const grants = new Map<string, string>();
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
      grants.set(name, grant.data.id);
      await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
        VALUES (${chat.id}::uuid, ${grant.data.id}::uuid, 'member', 'user', ${owner.id}::uuid)`;
    }
    expect((await candidates(owner, chat.shortId)).items).toEqual([
      { accessId: grants.get("Agent")!, type: "service_account", name: "Agent", agent: true },
      { accessId: grants.get("Service")!, type: "service_account", name: "Service", agent: false },
    ]);
    const message = await posted(owner, chat.shortId, { body: "Agent", mentions: [mention(grants.get("Agent")!, 0, 5)] });
    expect(message.mentions[0]?.name).toBe("Agent");
    await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${extraAccounts[0]!}::uuid`;
    expect((await candidates(owner, chat.shortId)).items.map((person) => person.name)).toEqual(["Service"]);
    expect((await send(owner, chat.shortId, { body: "Agent", mentions: [mention(grants.get("Agent")!, 0, 5)] })).status).toBe(400);
    expect((await send(owner, chat.shortId, { body: "Bound", mentions: [mention(grants.get("Bound")!, 0, 5)] })).status).toBe(400);
  });

  test("deduplicates mention plus reply, excludes self, tracks read/unread, and includes count in the SSR sidebar", async () => {
    const owner = await f.person("Owner"),
      mara = await f.person("Mara");
    const chat = await f.fixture(owner, [{ person: mara, permission: "write" }]);
    const original = await posted(mara, chat.shortId, { body: "Question" });
    const reply = await posted(owner, chat.shortId, { body: "Answer", replyTo: original.id });
    const both = await posted(owner, chat.shortId, { body: "Mara", replyTo: original.id, mentions: [mention(chat.entries.get(mara.id)!)] });
    await posted(mara, chat.shortId, { body: "Mara", mentions: [mention(chat.entries.get(mara.id)!)] });
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
    const message = await posted(owner, chat.shortId, { body: "Mara", thread: thread.id, mentions: [mention(chat.entries.get(mara.id)!)] });
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
    const message = await posted(owner, visible.shortId, { body: "Mara", mentions: [mention(visible.entries.get(mara.id)!)] });
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
          mentions: [{ ...mention(hidden.entries.get(mara.id)!), type: "user", id: mara.id }],
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
          mentions: [{ ...mention(chat.entries.get(mara.id)!), type: "user", id: mara.id }],
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
      mentions: [mention(chat.entries.get(mara.id)!)],
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
    test(`${containerType}: system mentions and candidates require container and item decisions; For you rechecks readers`, async () => {
      const owner = await f.person("Owner"),
        mara = await f.person("Mara"),
        denied = await f.person("Denied");
      // Existing principal grant IDs identify the targets without adding system-chat grants.
      const identities = await f.fixture(owner, [
        { person: mara, permission: "write" },
        { person: denied, permission: "write" },
      ]);
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
      expect((await candidates(owner, chat.id, `?thread=${thread.id}`)).items.map((person) => person.name)).toEqual(["Mara"]);
      const invalid = await send(owner, chat.id, {
        body: "Nope",
        thread: thread.id,
        mentions: [mention(identities.entries.get(denied.id)!)],
      });
      expect(invalid.status).toBe(400);
      const message = await posted(owner, chat.id, {
        body: "Mara",
        thread: thread.id,
        mentions: [mention(identities.entries.get(mara.id)!)],
      });
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
