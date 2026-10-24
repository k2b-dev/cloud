import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { redis, sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { chatService } from "../service";
import { ConversationSchema, ThreadSchema } from "../service/contracts";
import { conversationSearchTitle } from "../service/conversations";
import { accessKey, type ResourceReaderDependencies, resourceReaderDependencies } from "../service/resource-access";
import { SearchResultSchema } from "../service/search-contracts";
import { READER_REQUEST_BUDGET } from "../service/thread-access";
import chatApi from ".";
import { messageFixtures, type Person } from "./messages.test-fixture";

const suite = suiteFor("database", "nats", "valkey");
const at = "2026-10-24T12:00:00.000Z";
suite("chat list search", () => {
  const f = messageFixtures();
  const server = new Hono<AuthContext>().route("/api/chat", chatApi);
  type Reply = Awaited<ReturnType<ResourceReaderDependencies["invoke"]>>;
  const replies = new Map<string, Reply>();
  const lists = new Map<string, Reply>();
  const keys = new Set<string>();
  const calls: { app: string; capability: string; input: Record<string, unknown>; cookie?: string; signal?: AbortSignal }[] = [];
  let down: string | null = null;
  let readerDown = false;
  let abortOnList: AbortController | null = null;
  let reader: ReturnType<typeof spyOn>;
  const grant = (person: Person, type: string, id: string, data: Record<string, unknown>) => {
    keys.add(accessKey(`user:${person.id}`, { type, id }));
    replies.set(`${person.headers.cookie}:${type}:${id}`, {
      data: { id, ...data },
      links: [{ rel: "open", href: `/app/${type.split(".")[0]}/${id}` }],
    });
  };
  const api = (person: Pick<Person, "headers">, path: string, method = "GET", body?: unknown) =>
    server.request(`https://cloud.example.test/api/chat${path}`, {
      method,
      headers: { ...person.headers, "x-forwarded-for": uniqueCallerAddress(), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const search = async (person: Person, q: string) => {
    const response = await api(person, `/search?q=${encodeURIComponent(q)}`);
    expect(response.status).toBe(200);
    return SearchResultSchema.parse(await response.json());
  };
  const namedChat = async (owner: Person, name: string, members: Person[] = []) => {
    const chat = await f.fixture(
      owner,
      members.map((person) => ({ person, permission: "read" as const })),
    );
    await sql`UPDATE chat.conversations SET name = ${name}, last_activity_at = ${at}::timestamptz WHERE id = ${chat.id}::uuid`;
    return chat;
  };
  const manualThread = async (owner: Person, chat: string, name: string) => {
    const response = await f.request(owner.headers, `/${chat}/threads`, "POST", { name });
    expect(response.status).toBe(201);
    return ThreadSchema.parse(await response.json());
  };
  const open = async (person: Person, type: string, id: string) => {
    const response = await api(person, `/system-chats/${type}/${id}/open`, "POST");
    expect(response.status).toBe(200);
    const chat = ConversationSchema.parse(await response.json());
    f.trackChat(chat.id);
    return chat;
  };
  const itemThread = async (person: Person, chat: string, type: string, id: string) => {
    const response = await f.request(person.headers, `/${chat}/threads/for-resource`, "POST", { ref: { type, id } });
    expect(response.status).toBe(200);
    return ThreadSchema.parse(await response.json());
  };
  beforeEach(() => {
    replies.clear();
    lists.clear();
    calls.length = 0;
    down = null;
    readerDown = false;
    abortOnList = null;
    reader = spyOn(resourceReaderDependencies, "invoke").mockImplementation(async (app, capability, input, caller) => {
      calls.push({ app, capability, input, cookie: caller.cookie ?? undefined, signal: caller.signal });
      if (abortOnList && capability.endsWith(".list")) {
        abortOnList.abort();
        caller.signal?.throwIfAborted();
      }
      if (readerDown && capability.endsWith(".read")) throw new Error("Reader unavailable");
      if (down === app) throw new Error("Provider unavailable");
      const type = `${app}.${capability.split(".")[0]}`;
      if (capability.endsWith(".list")) {
        const override = lists.get(`${caller.cookie}:${type}`);
        if (override !== undefined) return override;
        const prefix = `${caller.cookie}:${type}:`;
        const q = String(input.query ?? "").toLowerCase();
        return {
          data: [...replies.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .flatMap(([, value]) => {
              if (!value || !value.data || typeof value.data !== "object" || !("name" in value.data)) return [];
              return String(value.data.name).toLowerCase().includes(q) ? [value.data] : [];
            })
            .slice(0, Number(input.limit)),
        };
      }
      const principal = personIds.get(caller.cookie ?? "");
      if (principal) keys.add(accessKey(`user:${principal}`, { type, id: String(input.id) }));
      return replies.get(`${caller.cookie}:${type}:${input.id}`) ?? null;
    });
  });
  const personIds = new Map<string, string>();
  const person = async (name?: string) => {
    const result = await f.person(name);
    personIds.set(result.headers.cookie!, result.id);
    return result;
  };
  afterEach(async () => {
    reader.mockRestore();
    if (keys.size) await redis.send("DEL", [...keys]);
    keys.clear();
    personIds.clear();
  });

  test("only members and subscribed channels appear; discovery alone does not add a hit", async () => {
    const owner = await person(),
      member = await person(),
      outsider = await person();
    const visible = await namedChat(owner, "Release IT", [member]);
    await namedChat(outsider, "Release secret");
    const response = await f.request(owner.headers, "", "POST", {
      name: "Release channel",
      purpose: "Announcements",
      discovery: [{ principal: { type: "authenticated" }, permission: "read" }],
    });
    expect(response.status).toBe(201);
    const created = await response.json();
    const channel = ConversationSchema.parse(created.conversation);
    f.trackChat(channel.id);
    expect((await search(member, "Release")).items.map((hit) => (hit.kind === "chat" ? hit.conversation.id : null))).toEqual([
      visible.shortId,
    ]);
    expect((await f.request(member.headers, `/${channel.id}/join`, "POST")).status).toBe(200);
    expect(
      (await search(member, "Release")).items
        .filter((hit) => hit.kind === "chat")
        .map((hit) => hit.conversation.id)
        .sort(),
    ).toEqual([visible.shortId, channel.id].sort());
  });

  test("ranks exact and prefix matches before words, with archived chats last", async () => {
    const owner = await person();
    const word = await namedChat(owner, "Team IT");
    const prefix = await namedChat(owner, "IT Support");
    const exact = await namedChat(owner, "IT");
    const archived = await namedChat(owner, "IT");
    expect((await f.request(owner.headers, `/${archived.shortId}/personal`, "PUT", { archived: true })).status).toBe(200);
    const result = await search(owner, "  it  ");
    expect(result.items.filter((hit) => hit.kind === "chat").map((hit) => hit.conversation.id)).toEqual([
      exact.shortId,
      prefix.shortId,
      word.shortId,
      archived.shortId,
    ]);
    expect(result.items.at(-1)).toMatchObject({ kind: "chat", conversation: { archived: true } });
  });

  test("same-rank results use recent activity and the final response never exceeds eight", async () => {
    const owner = await person();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const chat = await namedChat(owner, "Release");
      await sql`UPDATE chat.conversations SET last_activity_at = ${new Date(Date.UTC(2026, 9, 1 + i))} WHERE id = ${chat.id}::uuid`;
      ids.unshift(chat.shortId);
    }
    expect((await search(owner, "Release")).items.map((hit) => (hit.kind === "chat" ? hit.conversation.id : null))).toEqual(
      ids.slice(0, 8),
    );
  });

  test("searches generated titles with the same names as the list, including locale-specific self titles", async () => {
    const owner = await person("Owner"),
      peer = await person("Mira Example");
    const chat = await f.fixture(owner, [{ person: peer, permission: "read" }]);
    expect((await search(owner, "Mira Example")).items).toContainEqual(
      expect.objectContaining({ kind: "chat", conversation: expect.objectContaining({ id: chat.shortId, title: "Mira Example" }) }),
    );
    const self = await f.fixture(owner);
    const result = await chatService.search({ ...owner.context, locale: "de", query: { q: "Du" } });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.data.items).toContainEqual(
        expect.objectContaining({ kind: "chat", conversation: expect.objectContaining({ id: self.shortId }) }),
      );
  });

  test("SQL search titles match sidebar titles for multiple members and Unicode whitespace", async () => {
    const owner = await person("Owner");
    const peers = await Promise.all([person("  Mira\u00a0Example"), person("Jonas Example"), person("Zoë Example"), person("An Example")]);
    await sql`UPDATE auth.users SET given_name = ${"\t\u2003"} WHERE id = ${peers[0]!.id}::uuid`;
    await sql`UPDATE auth.users SET given_name = ${"\u2003Jonas\u00a0"} WHERE id = ${peers[1]!.id}::uuid`;
    for (const count of [0, 1, 2, 4]) {
      const chat = await f.fixture(
        owner,
        peers.slice(0, count).map((person) => ({ person, permission: "read" as const })),
      );
      const response = await f.request(owner.headers, `/${chat.shortId}`);
      expect(response.status).toBe(200);
      const listed = ConversationSchema.parse(await response.json());
      const [computed] = await sql<{ title: string }[]>`SELECT ${conversationSearchTitle(owner.context, sql)} AS title
        FROM chat.conversations c WHERE c.id = ${chat.id}::uuid`;
      expect(computed?.title).toBe(listed.title);
      expect((await search(owner, listed.title)).items).toContainEqual(
        expect.objectContaining({ kind: "chat", conversation: expect.objectContaining({ id: chat.shortId, title: listed.title }) }),
      );
    }
  });

  test("returns named non-archived threads only from the caller's chats", async () => {
    const owner = await person(),
      member = await person(),
      outsider = await person();
    const chat = await namedChat(owner, "IT", [member]);
    const visible = await manualThread(owner, chat.shortId, "Release plan");
    const archived = await manualThread(owner, chat.shortId, "Release old");
    expect((await f.request(owner.headers, `/${chat.shortId}/threads/${archived.id}`, "PATCH", { archived: true })).status).toBe(200);
    const hidden = await namedChat(outsider, "Private");
    await manualThread(outsider, hidden.shortId, "Release secret");
    expect((await search(member, "Release")).items).toEqual([
      { kind: "thread", conversation: { id: chat.shortId, title: "IT", kind: "chat" }, thread: { id: visible.id, name: "Release plan" } },
    ]);
  });

  test("uses literal SQL matching for punctuation and wildcard characters", async () => {
    const owner = await person();
    const chat = await namedChat(owner, "50% [done] _");
    await namedChat(owner, "Other");
    expect((await search(owner, "% [")).items).toEqual([
      expect.objectContaining({ kind: "chat", conversation: expect.objectContaining({ id: chat.shortId }) }),
    ]);
  });

  test("finds containers with and without chats and sends the caller, filter, limit and cancellation signal", async () => {
    const owner = await person(),
      outsider = await person();
    const space = testShortId(),
      book = testShortId(),
      denied = testShortId();
    grant(owner, "spaces.space", space, { name: "Release Space", permission: "write" });
    grant(owner, "notebooks.notebook", book, { name: "Release notes", permission: "read" });
    grant(outsider, "spaces.space", denied, { name: "Release secret", permission: "write" });
    const chat = await open(owner, "spaces.space", space);
    // A stale list entry cannot replace the container reader.
    lists.set(`${owner.headers.cookie}:spaces.space`, {
      data: [
        { id: space, name: "Release Space", permission: "write" },
        { id: denied, name: "Release secret", permission: "write" },
      ],
    });
    const result = await search(owner, "Release");
    expect(result.systemUnavailable).toBeUndefined();
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "system",
          ref: { type: "spaces.space", id: space },
          conversation: expect.objectContaining({ id: chat.id, summaryCursor: "" }),
        }),
        { kind: "system", ref: { type: "notebooks.notebook", id: book }, name: "Release notes", conversation: null },
      ]),
    );
    expect(result.items).toHaveLength(2);
    for (const app of ["spaces", "notebooks"]) {
      const call = calls.find((call) => call.app === app && call.capability.endsWith(".list"));
      expect(call?.input).toEqual({ limit: 100, query: "Release" });
      expect(call?.cookie).toBe(owner.headers.cookie);
      expect(call?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test("item hits use current reader names and completion, and enforce both container and item access", async () => {
    const owner = await person(),
      member = await person();
    const space = testShortId(),
      book = testShortId();
    const task = testShortId(),
      event = testShortId(),
      note = testShortId(),
      hidden = testShortId(),
      moved = testShortId();
    for (const p of [owner, member]) {
      grant(p, "spaces.space", space, { name: "Exhibition", permission: "write" });
      grant(p, "notebooks.notebook", book, { name: "Planning", permission: "write" });
    }
    for (const id of [task, event, hidden, moved])
      grant(owner, "spaces.item", id, { title: "Old snapshot", kind: id === event ? "event" : "task", spaceId: space });
    grant(owner, "notebooks.note", note, { title: "Old note", notebookId: book });
    const spaceChat = await open(owner, "spaces.space", space),
      bookChat = await open(owner, "notebooks.notebook", book);
    const taskThread = await itemThread(owner, spaceChat.id, "spaces.item", task);
    const eventThread = await itemThread(owner, spaceChat.id, "spaces.item", event);
    await itemThread(owner, spaceChat.id, "spaces.item", hidden);
    await itemThread(owner, spaceChat.id, "spaces.item", moved);
    const noteThread = await itemThread(owner, bookChat.id, "notebooks.note", note);
    grant(member, "spaces.item", task, { title: "Release task", kind: "task", spaceId: space, completedAt: at });
    grant(member, "spaces.item", event, { title: "Release event", kind: "event", spaceId: space });
    grant(member, "notebooks.note", note, { title: "Release note", notebookId: book });
    grant(member, "spaces.item", moved, { title: "Release moved", kind: "task", spaceId: testShortId() });
    const result = await search(member, "Release");
    expect(result.items).toHaveLength(3);
    expect(result.items).toEqual(
      expect.arrayContaining([
        {
          kind: "thread",
          conversation: { id: spaceChat.id, title: "Exhibition", kind: "system" },
          thread: { id: taskThread.id, name: "Release task", resource: { kind: "task", done: true } },
        },
        expect.objectContaining({
          kind: "thread",
          thread: { id: eventThread.id, name: "Release event", resource: { kind: "event", done: false } },
        }),
        expect.objectContaining({
          kind: "thread",
          thread: { id: noteThread.id, name: "Release note", resource: { kind: "note", done: false } },
        }),
      ]),
    );
    replies.delete(`${member.headers.cookie}:spaces.space:${space}`);
    await redis.del(accessKey(`user:${member.id}`, { type: "spaces.space", id: space }));
    expect((await search(member, "Release")).items).toEqual([
      expect.objectContaining({ kind: "thread", thread: expect.objectContaining({ id: noteThread.id }) }),
    ]);
  });

  test("item candidate selection uses the caller's container directory before its limit", async () => {
    const owner = await person(),
      other = await person();
    const space = testShortId(),
      foreignSpace = testShortId(),
      item = testShortId();
    grant(owner, "spaces.space", space, { name: "Planning", permission: "write" });
    grant(owner, "spaces.item", item, { title: "Release plan", kind: "task", spaceId: space });
    const chat = await open(owner, "spaces.space", space);
    const visible = await itemThread(owner, chat.id, "spaces.item", item);
    await sql`UPDATE chat.threads SET last_activity_at = '2000-01-01T00:00:00Z' WHERE short_id = ${visible.id}`;
    const foreign = await f.fixture(other);
    await sql`UPDATE chat.conversations SET kind = 'system', resource_type = 'spaces.space', resource_id = ${foreignSpace} WHERE id = ${foreign.id}::uuid`;
    const newer = Array.from({ length: 100 }, () => ({ short_id: testShortId(), resource_id: testShortId() }));
    await sql`INSERT INTO chat.threads (short_id, conversation_id, name, resource_type, resource_id, created_by_type, created_by_id, last_activity_at)
      SELECT item_record.short_id, ${foreign.id}::uuid, 'Release other', 'spaces.item', item_record.resource_id, 'user', ${other.id}::uuid, '2100-01-01T00:00:00Z'
      FROM jsonb_to_recordset(${JSON.stringify(newer)}::jsonb) AS item_record(short_id text, resource_id text)`;
    calls.length = 0;
    expect((await search(owner, "Release")).items).toEqual([
      expect.objectContaining({ kind: "thread", thread: expect.objectContaining({ id: visible.id }) }),
    ]);
    expect(calls.length).toBeLessThanOrEqual(READER_REQUEST_BUDGET);
    expect(calls.filter((call) => call.capability.endsWith(".list"))).toHaveLength(4);
    expect(calls.some((call) => call.input.id === foreignSpace || newer.some((row) => row.resource_id === call.input.id))).toBe(false);
  });

  test("cache misses cannot exceed the shared owner-invocation budget", async () => {
    const owner = await person();
    const space = testShortId();
    grant(owner, "spaces.space", space, { name: "Planning", permission: "write" });
    const chat = await open(owner, "spaces.space", space);
    const entries = Array.from({ length: 100 }, () => ({ short_id: testShortId(), resource_id: testShortId() }));
    for (const entry of entries) grant(owner, "spaces.item", entry.resource_id, { title: "Release", kind: "task", spaceId: space });
    await sql`INSERT INTO chat.threads (short_id, conversation_id, name, resource_type, resource_id, created_by_type, created_by_id, last_activity_at)
      SELECT item_record.short_id, c.id, 'Snapshot', 'spaces.item', item_record.resource_id, 'user', ${owner.id}::uuid, ${at}::timestamptz
      FROM jsonb_to_recordset(${JSON.stringify(entries)}::jsonb) AS item_record(short_id text, resource_id text)
      CROSS JOIN chat.conversations c WHERE c.short_id = ${chat.id}`;
    const originalGet = redis.get.bind(redis);
    const cacheMiss = spyOn(redis, "get").mockImplementation(async (key) => {
      if (typeof key === "string" && key.startsWith("chat:access:")) return null;
      return originalGet(key);
    });
    calls.length = 0;
    try {
      const result = await chatService.search({ ...owner.context, query: { q: "Release" } });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.items.length).toBeLessThanOrEqual(8);
        expect(result.data.systemUnavailable).toBe(true);
      }
      expect(calls.length).toBeLessThanOrEqual(READER_REQUEST_BUDGET);
    } finally {
      cacheMiss.mockRestore();
    }
  });

  test("ordinary Unicode matching and word ranking agree with the browser matcher before LIMIT", async () => {
    const owner = await person();
    const unicode = await namedChat(owner, "Ärzte");
    expect((await search(owner, "ärz")).items).toEqual([
      expect.objectContaining({ kind: "chat", conversation: expect.objectContaining({ id: unicode.shortId }) }),
    ]);
    const word = await namedChat(owner, "Team IT");
    await sql`UPDATE chat.conversations SET last_activity_at = '2000-01-01T00:00:00Z' WHERE id = ${word.id}::uuid`;
    for (let i = 0; i < 9; i++) await namedChat(owner, `üIT${i}`);
    expect((await search(owner, "it")).items[0]).toMatchObject({ kind: "chat", conversation: { id: word.shortId } });
  });

  test("owner failure retains ordinary hits and the healthy owner, with systemUnavailable", async () => {
    const owner = await person();
    const chat = await namedChat(owner, "Release IT");
    const book = testShortId();
    grant(owner, "notebooks.notebook", book, { name: "Release notes", permission: "read" });
    down = "spaces";
    const result = await search(owner, "Release");
    expect(result.systemUnavailable).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "chat", conversation: expect.objectContaining({ id: chat.shortId }) }),
        expect.objectContaining({ kind: "system", ref: { type: "notebooks.notebook", id: book } }),
      ]),
    );
  });

  test("unavailable high-ranked containers cannot crowd ordinary hits out of the eight-result response", async () => {
    const owner = await person();
    const chat = await namedChat(owner, "IT Support");
    lists.set(`${owner.headers.cookie}:spaces.space`, {
      data: Array.from({ length: 12 }, () => ({ id: testShortId(), name: "IT", permission: "read" })),
    });
    readerDown = true;
    const result = await search(owner, "IT");
    expect(result.systemUnavailable).toBe(true);
    expect(result.items).toEqual([expect.objectContaining({ kind: "chat", conversation: expect.objectContaining({ id: chat.shortId }) })]);
  });

  test("reader failures and malformed owner lists set the partial-failure flag", async () => {
    const owner = await person();
    await namedChat(owner, "Release");
    lists.set(`${owner.headers.cookie}:spaces.space`, { data: [{ id: testShortId(), name: "Release", permission: "read" }] });
    lists.set(`${owner.headers.cookie}:notebooks.notebook`, { data: "malformed" });
    readerDown = true;
    const result = await search(owner, "Release");
    expect(result.systemUnavailable).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.kind).toBe("chat");
  });

  test("an abort during owner discovery stops further reader batches", async () => {
    const owner = await person();
    abortOnList = new AbortController();
    await expect(
      chatService.search({
        ...owner.context,
        caller: { cookie: owner.headers.cookie, signal: abortOnList.signal },
        query: { q: "Release" },
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("invalid queries fail before owner discovery and client abort stops work", async () => {
    const owner = await person();
    for (const query of ["", "q=", "q=%20", `q=${"x".repeat(101)}`]) expect((await api(owner, `/search?${query}`)).status).toBe(400);
    expect(calls).toHaveLength(0);
    await expect(
      chatService.search({
        ...owner.context,
        caller: { cookie: owner.headers.cookie, signal: AbortSignal.abort() },
        query: { q: "Release" },
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
