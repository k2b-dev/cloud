import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { redis, sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { ItemEventsPageSchema } from "../service/contracts";
import { accessKey, resourceReaderDependencies } from "../service/resource-access";
import { messageFixtures, type Person } from "./messages.test-fixture";

const suite = suiteFor("database", "nats", "valkey");
suite("system chat item events", () => {
  const f = messageFixtures();
  let invocation: ReturnType<typeof spyOn>;
  const keys = new Set<string>();
  const calls: {
    app: string;
    capability: string;
    input: Record<string, unknown>;
    cookie: string | null | undefined;
    locale: string | null | undefined;
  }[] = [];
  const grants = new Map<string, Record<string, unknown>>();
  let events: unknown[] = [];
  let unavailable = false;
  let denied = false;
  beforeEach(() => {
    grants.clear();
    calls.length = 0;
    events = [];
    unavailable = false;
    denied = false;
    invocation = spyOn(resourceReaderDependencies, "invoke").mockImplementation(async (app, capability, input, caller) => {
      calls.push({ app, capability, input, cookie: caller.cookie, locale: caller.locale });
      if (capability.endsWith(".activity")) {
        if (unavailable) throw new Error("Owner unavailable");
        if (denied) return null;
        return { data: events, page: { nextCursor: "owner-cursor" } };
      }
      const data = grants.get(`${caller.cookie?.split(";")[0]}:${app}.${capability.split(".")[0]}:${input.id}`);
      return data ? { data: { id: input.id, ...data }, links: [{ rel: "open", href: "/app/resource" }] } : null;
    });
  });
  afterEach(async () => {
    invocation.mockRestore();
    if (keys.size) await redis.send("DEL", [...keys]);
    keys.clear();
  });
  const grant = (person: Person, type: string, id: string, data: Record<string, unknown>) => {
    grants.set(`${person.headers.cookie}:${type}:${id}`, data);
    keys.add(accessKey(`user:${person.id}`, { type, id }));
  };
  const system = async (person: Person, type = "spaces.space") => {
    const resource = testShortId(),
      shortId = testShortId();
    const [row] = await sql<
      { id: string }[]
    >`INSERT INTO chat.conversations (short_id, kind, resource_type, resource_id, created_by_type, created_by_id) VALUES (${shortId}, 'system', ${type}, ${resource}, 'user', ${person.id}::uuid) RETURNING id`;
    f.trackChat(shortId);
    grant(person, type, resource, { permission: "read", name: "Project" });
    return { id: row!.id, shortId, resource };
  };
  const event = (id: string, type = "spaces.item") => ({
    id: "1",
    at: "2026-10-23T12:00:00Z",
    ref: { type, id },
    actor: { type: "user", id: "11111111-1111-4111-8111-111111111111", name: "Mara" },
    icon: "ti ti-check",
    sentence: "Mara completed the task",
    count: 1,
  });
  test("rejects ordinary conversations and denied container or item access with 404", async () => {
    const person = await f.person(),
      other = await f.person();
    const ordinary = await f.fixture(person);
    expect((await f.request(person.headers, `/${ordinary.shortId}/events`)).status).toBe(404);
    const chat = await system(person);
    keys.add(accessKey(`user:${other.id}`, { type: "spaces.space", id: chat.resource }));
    expect((await f.request(other.headers, `/${chat.shortId}/events`)).status).toBe(404);
    const thread = testShortId(),
      ref = testShortId();
    await sql`INSERT INTO chat.threads (short_id, conversation_id, name, resource_type, resource_id, created_by_type, created_by_id) VALUES (${thread}, ${chat.id}::uuid, 'Hidden', 'spaces.item', ${ref}, 'user', ${person.id}::uuid)`;
    keys.add(accessKey(`user:${person.id}`, { type: "spaces.item", id: ref }));
    expect((await f.request(person.headers, `/${chat.shortId}/events?thread=${thread}`)).status).toBe(404);
    denied = true;
    expect((await f.request(person.headers, `/${chat.shortId}/events`)).status).toBe(404);
  });
  test("maps All and item threads, preserves the caller and cursor, and leaves message state unchanged", async () => {
    const person = await f.person(),
      chat = await system(person);
    const ref = testShortId(),
      missing = testShortId(),
      thread = testShortId();
    grant(person, "spaces.item", ref, { title: "Current task title", kind: "task", spaceId: chat.resource });
    await sql`INSERT INTO chat.threads (short_id, conversation_id, name, resource_type, resource_id, created_by_type, created_by_id) VALUES (${thread}, ${chat.id}::uuid, 'Stale title', 'spaces.item', ${ref}, 'user', ${person.id}::uuid)`;
    events = [event(ref), { ...event(missing), id: "2" }];
    const response = await f.request(
      { ...person.headers, "accept-language": "de", cookie: `${person.headers.cookie}; cloud.timezone=America/New_York` },
      `/${chat.shortId}/events?thread=all&limit=100&cursor=previous`,
    );
    expect(response.status).toBe(200);
    const page = ItemEventsPageSchema.parse(await response.json());
    expect(page.items.map((item) => item.thread)).toEqual([
      { id: thread, name: "Current task title" },
      { ref: { type: "spaces.item", id: missing } },
    ]);
    expect(page.nextCursor).toBe("owner-cursor");
    const call = calls.find((call) => call.capability === "space.activity")!;
    expect(call).toMatchObject({
      app: "spaces",
      locale: "de",
      input: { space: chat.resource, cursor: "previous", limit: 100, timeZone: "America/New_York" },
    });
    expect(call.cookie).toContain(person.headers.cookie!);
    const selected = await f.request(person.headers, `/${chat.shortId}/events?thread=${thread}&after=2026-10-22T00:00:00Z`);
    expect(selected.status).toBe(200);
    expect(ItemEventsPageSchema.parse(await selected.json()).items).toHaveLength(1);
    expect(calls.at(-1)?.input).toMatchObject({ item: ref, after: "2026-10-22T00:00:00Z" });
    const [state] = await sql<
      { seq_head: string | bigint; messages: number; participants: number }[]
    >`SELECT seq_head, (SELECT COUNT(*)::int FROM chat.messages WHERE conversation_id = ${chat.id}::uuid) AS messages, (SELECT COUNT(*)::int FROM chat.participants WHERE conversation_id = ${chat.id}::uuid) AS participants FROM chat.conversations WHERE id = ${chat.id}::uuid`;
    expect(String(state?.seq_head)).toBe("0");
    expect(state?.messages).toBe(0);
    expect(state?.participants).toBe(0);
  });
  test("uses notebook.activity and keeps an unavailable or malformed owner feed recoverable", async () => {
    const person = await f.person(),
      chat = await system(person, "notebooks.notebook");
    unavailable = true;
    const response = await f.request(person.headers, `/${chat.shortId}/events`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], nextCursor: null, unavailable: true });
    expect(calls.at(-1)).toMatchObject({ app: "notebooks", capability: "notebook.activity", input: { notebook: chat.resource } });
    unavailable = false;
    events = [{ malformed: true }];
    expect(await (await f.request(person.headers, `/${chat.shortId}/events`)).json()).toEqual({
      items: [],
      nextCursor: null,
      unavailable: true,
    });
    events = [event(testShortId(), "notebooks.note")];
    expect(ItemEventsPageSchema.parse(await (await f.request(person.headers, `/${chat.shortId}/events`)).json()).items).toHaveLength(1);
    expect((await f.request(person.headers, `/${chat.shortId}/events?limit=101`)).status).toBe(400);
  });
});
