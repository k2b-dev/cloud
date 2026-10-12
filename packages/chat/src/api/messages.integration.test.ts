import { afterEach, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { sql } from "bun";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { requireConversation } from "../service/access";
import { ChangesPageSchema, MemberPageSchema, MessagePageSchema, MessageViewSchema } from "../service/contracts";
import { appendMessage, type MessageRow, projectMessage } from "../service/message-store";
import { messageFixtures, type Person } from "./messages.test-fixture";

setDefaultTimeout(120_000);
const suite = suiteFor("database", "nats", "valkey");
suite("chat messages", () => {
  const f = messageFixtures();
  // The limiter weighs in the previous window; sends that straddle a window edge would make the limit tests flaky.
  const freezeAtWindowStart = () => setSystemTime(new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 1_000));
  afterEach(() => {
    setSystemTime();
  });
  const send = (person: Person, shortId: string, clientId: string, body = "**Hello** 😀") =>
    f.request(person.headers, `/${shortId}/messages`, "POST", { clientId, body });
  const page = async (person: Person, shortId: string, query = "") => {
    const response = await f.request(person.headers, `/${shortId}/messages${query}`);
    expect(response.status).toBe(200);
    return MessagePageSchema.parse(await response.json());
  };
  const changes = async (person: Person, shortId: string, afterRev: number) => {
    const response = await f.request(person.headers, `/${shortId}/changes?afterRev=${afterRev}`);
    expect(response.status).toBe(200);
    return ChangesPageSchema.parse(await response.json());
  };
  const fill = async (person: Person, shortId: string, count: number) => {
    await sql.begin(async (db) => {
      await db`SELECT id FROM chat.conversations WHERE short_id = ${shortId} FOR UPDATE`;
      const allowed = await requireConversation({ ...person.context, conversationId: shortId, required: "write" }, db);
      if (!allowed.ok) throw new Error(allowed.error.message);
      for (let i = 0; i < count; i++)
        await appendMessage(db, allowed.data, person.context, { kind: "text", clientId: `fixture-${i}`, body: `Message ${i}` });
    });
  };
  const outbox = (shortId: string) => sql<
    { ordering_key: string; payload: unknown }[]
  >`SELECT ordering_key, payload FROM events.outbox WHERE app_id = 'chat'
    AND ordering_key IN (${"c:" + shortId}, ${"l:" + shortId}) ORDER BY seq`;

  test("50 parallel writers expose only gapless prefixes, and delta receives each once", async () => {
    const people = [];
    for (let i = 0; i < 50; i++) people.push(await f.person(`Writer ${i}`));
    const owner = people[0]!;
    const reader = { ...owner, headers: await f.credential(owner) };
    const chat = await f.fixture(
      owner,
      people.slice(1).map((person) => ({ person, permission: "write" })),
    );
    let finished = false;
    let snapshots = 0;
    const seen: string[] = [];
    const poller = (async () => {
      do {
        const snapshot = await page(reader, chat.shortId);
        expect(snapshot.items.map((m) => m.seq)).toEqual(Array.from({ length: snapshot.seqHead }, (_, i) => i + 1));
        expect(snapshot.rev).toBe(snapshot.seqHead);
        snapshots++;
      } while (!finished);
    })();
    const deltaReader = (async () => {
      let watermark = 0;
      do {
        const lastRead = finished;
        const delta = await changes(reader, chat.shortId, watermark);
        seen.push(...delta.messages.map((m) => m.id));
        watermark = delta.rev;
        if (lastRead && !delta.more) break;
      } while (true);
    })();
    const writing = Promise.all(people.map((p, i) => send(p, chat.shortId, `parallel-${i}`))).finally(() => {
      finished = true;
    });
    const [responses] = await Promise.all([writing, poller, deltaReader]);
    expect(responses.every((r) => r.status === 201)).toBeTrue();
    expect(snapshots).toBeGreaterThan(0);
    const final = await page(owner, chat.shortId);
    expect(final.items.map((m) => m.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(new Set(final.items.map((m) => m.rev)).size).toBe(50);
    expect(seen).toHaveLength(50);
    expect(new Set(seen)).toEqual(new Set(final.items.map((m) => m.id)));
  });

  test("a send waits for an open writer, so no reader sees a later number first", async () => {
    const owner = await f.person();
    const other = await f.person();
    const chat = await f.fixture(owner, [{ person: other, permission: "write" }]);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let appended = () => {};
    const firstAppended = new Promise<void>((resolve) => {
      appended = resolve;
    });
    const first = sql.begin(async (db) => {
      await db`SELECT id FROM chat.conversations WHERE id = ${chat.id}::uuid FOR UPDATE`;
      const allowed = await requireConversation({ ...owner.context, conversationId: chat.shortId, required: "write" }, db);
      if (!allowed.ok) throw new Error(allowed.error.message);
      await appendMessage(db, allowed.data, owner.context, { kind: "text", clientId: "held", body: "First" });
      appended();
      await held;
    });
    await firstAppended;
    let secondDone = false;
    const second = Promise.resolve(send(other, chat.shortId, "waiting", "Second")).then((response) => {
      secondDone = true;
      return response;
    });
    await Bun.sleep(300);
    // With numbers from a sequence instead of the row lock, the second send would already be visible as seq 2.
    expect(secondDone).toBeFalse();
    expect((await page(owner, chat.shortId)).items).toEqual([]);
    expect(await changes(owner, chat.shortId, 0)).toMatchObject({ rev: 0, messages: [] });
    release();
    await first;
    const response = await second;
    expect(response.status).toBe(201);
    expect(MessageViewSchema.parse(await response.json()).seq).toBe(2);
    expect((await page(owner, chat.shortId)).items.map((m) => m.body)).toEqual(["First", "Second"]);
  });

  test("50 concurrent retries create one row and return one ID", async () => {
    const person = await f.person();
    const owner = { ...person, headers: await f.credential(person) };
    const chat = await f.fixture(owner);
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => send(owner, chat.shortId, "shared", `Body ${i}`)));
    // Limits run before the lock, so retries racing the first send may spend the budget and get 429.
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.every((r) => [200, 201, 429].includes(r.status))).toBeTrue();
    const items = await Promise.all(responses.filter((r) => r.ok).map(async (r) => MessageViewSchema.parse(await r.json())));
    expect(new Set(items.map((m) => m.id)).size).toBe(1);
    expect((await page(owner, chat.shortId)).seqHead).toBe(1);
    await f.resetSendLimits([owner], chat.shortId);
    const retry = await send(owner, chat.shortId, "shared", "changed");
    expect(retry.status).toBe(200);
    expect(MessageViewSchema.parse(await retry.json()).id).toBe(items[0]!.id);
  });

  test("client IDs belong to the author; sending changes no participant row", async () => {
    const owner = await f.person();
    const other = await f.person();
    const chat = await f.fixture(owner, [{ person: other, permission: "write" }]);
    const participants = () =>
      sql<
        { row: unknown }[]
      >`SELECT to_jsonb(p) AS row FROM chat.participants p WHERE conversation_id = ${chat.id}::uuid ORDER BY principal_id`;
    const before = await participants();
    const results = await Promise.all([send(owner, chat.shortId, "same"), send(other, chat.shortId, "same")]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const ids = await Promise.all(results.map(async (r) => MessageViewSchema.parse(await r.json()).id));
    expect(new Set(ids).size).toBe(2);
    expect(await participants()).toEqual(before);
  });

  test("history pages both ways, remains stable across new messages, and resolves deep links", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    await fill(owner, chat.shortId, 125);
    const latest = await page(owner, chat.shortId);
    expect(latest.seqHead).toBe(125);
    expect(latest.items.map((m) => m.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 76 + i));
    const prior = await page(owner, chat.shortId, "?before=76");
    expect(prior.items.map((m) => m.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 26 + i));
    expect((await send(owner, chat.shortId, "new-arrival")).status).toBe(201);
    expect((await page(owner, chat.shortId, "?before=76")).items).toEqual(prior.items);
    const first = await page(owner, chat.shortId, "?before=26");
    expect(first.items.map((m) => m.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect([...first.items, ...prior.items, ...latest.items].map((m) => m.seq)).toEqual(Array.from({ length: 125 }, (_, i) => i + 1));
    const forward = [...first.items];
    let after = 25;
    while (after < 126) {
      const next = await page(owner, chat.shortId, `?after=${after}`);
      expect(next.items.length).toBeGreaterThan(0);
      forward.push(...next.items);
      after = next.items.at(-1)!.seq;
    }
    expect(forward.map((m) => m.seq)).toEqual(Array.from({ length: 126 }, (_, i) => i + 1));
    const anchor = latest.items[12]!;
    const response = await f.request(owner.headers, `/${chat.shortId}/messages/${anchor.id}`);
    expect(response.status).toBe(200);
    expect(MessageViewSchema.parse(await response.json())).toEqual(anchor);
    const another = await f.fixture(owner);
    expect((await f.request(owner.headers, `/${another.shortId}/messages/${anchor.id}`)).status).toBe(404);
  });

  test("delta pages 200 changes, reports state revisions, and rejects a future watermark", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    await fill(owner, chat.shortId, 405);
    const first = await changes(owner, chat.shortId, 0);
    expect(first).toMatchObject({ rev: 200, more: true, conversation: null });
    expect(first.messages).toHaveLength(200);
    const second = await changes(owner, chat.shortId, first.rev);
    expect(second).toMatchObject({ rev: 400, more: true, conversation: null });
    expect(second.messages).toHaveLength(200);
    const third = await changes(owner, chat.shortId, second.rev);
    expect(third).toMatchObject({ rev: 405, more: false, conversation: null });
    expect([...first.messages, ...second.messages, ...third.messages].map((m) => m.seq)).toEqual(
      Array.from({ length: 405 }, (_, i) => i + 1),
    );
    expect((await f.request(owner.headers, `/${chat.shortId}`, "PATCH", { name: "New name" })).status).toBe(200);
    const renamed = await changes(owner, chat.shortId, third.rev);
    expect(renamed.conversation?.name).toBe("New name");
    expect(renamed.messages[0]?.system).toEqual({ code: "details_changed", params: { name: "New name" } });
    expect((await changes(owner, chat.shortId, renamed.rev)).conversation).toBeNull();
    const future = await f.request({ ...owner.headers, "accept-language": "de" }, `/${chat.shortId}/changes?afterRev=99999`);
    expect(future.status).toBe(409);
    expect(await future.json()).toEqual({ code: "RESYNC_REQUIRED", message: "Der Chatverlauf hat sich geändert. Lade den Chat neu." });
  });

  test("each state operation writes its system line; no-ops and failures leave revisions unchanged", async () => {
    const owner = await f.person("Alex");
    const other = await f.person("Lea");
    const newcomer = await f.person("Tim");
    const chat = await f.create(owner, [other]);
    const path = `/${chat.shortId}`;
    const members = async () => MemberPageSchema.parse(await (await f.request(owner.headers, `${path}/members`)).json()).items;
    const entry = async (person: Person) => (await members()).find((m) => m.principal.userId === person.id)!.accessId;
    const head = async () => {
      const [row] = await sql<
        { seq_head: string; rev: string; changed_rev: string; last_activity_at: Date }[]
      >`SELECT seq_head, rev, changed_rev, last_activity_at FROM chat.conversations WHERE id = ${chat.id}::uuid`;
      return row!;
    };
    const initial = await head();
    expect(Number(initial.seq_head)).toBe(1);
    expect((await f.request(owner.headers, path, "PATCH", { name: "Work", purpose: "Planning" })).status).toBe(200);
    const renamed = await head();
    expect(Number(renamed.rev)).toBe(2);
    expect(Number(renamed.changed_rev)).toBe(2);
    expect((await f.request(owner.headers, path, "PATCH", { name: "Work" })).status).toBe(200);
    expect(await head()).toEqual(renamed);
    expect((await f.request(owner.headers, `${path}/members`, "POST", { members: [newcomer.id] })).status).toBe(200);
    const [part] = await sql<
      { joined_seq: string }[]
    >`SELECT joined_seq FROM chat.participants WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${newcomer.id}::uuid`;
    expect(Number(part!.joined_seq)).toBe(2);
    const added = await head();
    expect((await f.request(owner.headers, `${path}/members`, "POST", { members: [newcomer.id] })).status).toBe(200);
    expect(await head()).toEqual(added);
    const newcomerAccess = await entry(newcomer);
    expect((await f.request(owner.headers, `${path}/members/${newcomerAccess}`, "PATCH", { permission: "write" })).status).toBe(200);
    expect(await head()).toEqual(added);
    expect((await f.request(owner.headers, `${path}/members/${newcomerAccess}`, "PATCH", { permission: "read" })).status).toBe(200);
    expect((await f.request(owner.headers, `${path}/members/${newcomerAccess}`, "DELETE")).status).toBe(200);
    const beforeFailure = await head();
    expect((await f.request(owner.headers, `${path}/members/${await entry(owner)}`, "DELETE")).status).toBe(409);
    expect(await head()).toEqual(beforeFailure);
    const successor = await entry(other);
    expect((await f.request(owner.headers, `${path}/leave`, "POST", { successor })).status).toBe(200);
    const lines = await page(other, chat.shortId);
    expect(lines.items.map((m) => m.system)).toEqual([
      { code: "conversation_created", params: {} },
      { code: "details_changed", params: { name: "Work", purpose: "Planning" } },
      { code: "members_added", params: { members: [{ id: newcomer.id, name: "Tim" }] } },
      { code: "permission_changed", params: { member: { id: newcomer.id, name: "Tim" }, permission: "read" } },
      { code: "member_removed", params: { member: { id: newcomer.id, name: "Tim" } } },
      { code: "member_left", params: { successor: { id: other.id, name: "Lea" } } },
    ]);
    expect(lines.items.every((m) => m.author.id === owner.id && m.author.name === "Alex")).toBeTrue();
    expect((await head()).last_activity_at).toEqual(initial.last_activity_at);
    const rows =
      await sql`SELECT * FROM chat.participants WHERE conversation_id = ${chat.id}::uuid AND principal_id IN (${owner.id}::uuid, ${newcomer.id}::uuid)`;
    expect(rows).toHaveLength(0);
    const english = await f.request({ ...other.headers, "accept-language": "en" }, `${path}/messages/${lines.items[0]!.id}`);
    const german = await f.request({ ...other.headers, "accept-language": "de" }, `${path}/messages/${lines.items[0]!.id}`);
    expect(MessageViewSchema.parse(await english.json()).systemText).toBe("Alex created the chat.");
    expect(MessageViewSchema.parse(await german.json()).systemText).toBe("Alex hat den Chat erstellt.");
  });

  test("sending publishes full message and summary atomically; failures publish nothing", async () => {
    const owner = await f.person("Alex");
    const reader = await f.person("Lea");
    const chat = await f.fixture(owner, [{ person: reader, permission: "read" }]);
    await sql`UPDATE chat.conversations SET last_activity_at = '2020-01-01' WHERE id = ${chat.id}::uuid`;
    const response = await send(owner, chat.shortId, "live", "  Hello\n **world** 😀 ");
    expect(response.status).toBe(201);
    const message = MessageViewSchema.parse(await response.json());
    const rows = await sql<MessageRow[]>`SELECT * FROM chat.messages WHERE conversation_id = ${chat.id}::uuid`;
    const shared = projectMessage(rows[0]!, chat.shortId);
    expect(await outbox(chat.shortId)).toEqual([
      { ordering_key: `c:${chat.shortId}`, payload: { v: 1, k: `c:${chat.shortId}`, d: { type: "message", message: shared } } },
      {
        ordering_key: `l:${chat.shortId}`,
        payload: {
          v: 1,
          k: `l:${chat.shortId}`,
          d: {
            type: "summary",
            conversationId: chat.shortId,
            id: message.id,
            seq: 1,
            rev: 1,
            kind: "text",
            author: message.author,
            preview: "Hello **world** 😀",
            mention: false,
          },
        },
      },
    ]);
    const before = await outbox(chat.shortId);
    expect((await send(reader, chat.shortId, "rejected")).status).toBe(403);
    expect(await outbox(chat.shortId)).toEqual(before);
    await expect(
      sql.begin(async (db) => {
        await db`SELECT id FROM chat.conversations WHERE id = ${chat.id}::uuid FOR UPDATE`;
        const allowed = await requireConversation({ ...owner.context, conversationId: chat.shortId, required: "write" }, db);
        if (!allowed.ok) throw new Error(allowed.error.message);
        await appendMessage(db, allowed.data, owner.context, { kind: "text", clientId: "rollback", body: "Rollback" });
        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow("deliberate rollback");
    expect(await outbox(chat.shortId)).toEqual(before);
    const snapshot = await page(owner, chat.shortId);
    expect(snapshot.seqHead).toBe(1);
    const [head] = await sql<
      { changed_rev: string; last_activity_at: Date }[]
    >`SELECT changed_rev, last_activity_at FROM chat.conversations WHERE id = ${chat.id}::uuid`;
    expect(Number(head!.changed_rev)).toBe(0);
    expect(head!.last_activity_at.getUTCFullYear()).toBeGreaterThan(2020);
  });

  test("membership changes publish access rows on both keys", async () => {
    const owner = await f.person();
    const member = await f.person();
    const newcomer = await f.person();
    const chat = await f.fixture(owner, [{ person: member, permission: "write" }]);
    const path = `/${chat.shortId}`;
    const operations = [
      () => f.request(owner.headers, `${path}/members`, "POST", { members: [newcomer.id] }),
      () => f.request(owner.headers, `${path}/members/${chat.entries.get(member.id)}`, "PATCH", { permission: "admin" }),
      async () => {
        const entries = MemberPageSchema.parse(await (await f.request(owner.headers, `${path}/members`)).json()).items;
        return f.request(owner.headers, `${path}/members/${entries.find((m) => m.principal.userId === newcomer.id)!.accessId}`, "DELETE");
      },
      () => f.request(owner.headers, `${path}/leave`, "POST", {}),
    ];
    for (const operation of operations) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key IN (${"c:" + chat.shortId}, ${"l:" + chat.shortId})`;
      expect((await operation()).status).toBe(200);
      const rows = await outbox(chat.shortId);
      expect(rows).toHaveLength(4);
      expect(rows.map((r) => z.object({ k: z.string(), a: z.boolean().optional() }).parse(r.payload)).filter((p) => p.a)).toEqual([
        { k: `c:${chat.shortId}`, a: true },
        { k: `l:${chat.shortId}`, a: true },
      ]);
      expect(z.object({ d: z.object({ preview: z.null() }) }).parse(rows[3]!.payload).d.preview).toBeNull();
    }
  });

  for (const delegated of [false, true])
    for (const permission of ["none", "read", "write", "admin"] as const)
      test(`${delegated ? "delegated person" : "session"} ${permission}: permission on every message path`, async () => {
        const owner = await f.person();
        const caller = await f.person();
        const chat = await f.fixture(owner, permission === "none" ? [] : [{ person: caller, permission }]);
        const response = await send(owner, chat.shortId, "anchor");
        const anchor = MessageViewSchema.parse(await response.json());
        const headers = delegated ? await f.credential(caller) : caller.headers;
        for (const suffix of ["/messages", `/messages/${anchor.id}`, "/changes?afterRev=0"]) {
          expect((await f.request(headers, `/${chat.shortId}${suffix}`)).status).toBe(permission === "none" ? 404 : 200);
        }
        const posted = await f.request(headers, `/${chat.shortId}/messages`, "POST", { clientId: "new", body: "Delegated body" });
        expect(posted.status).toBe(permission === "none" ? 404 : permission === "read" ? 403 : 201);
        if (posted.ok) {
          const message = MessageViewSchema.parse(await posted.json());
          expect(message.author).toEqual({ type: "user", id: caller.id, name: caller.name });
          const retry = await send(caller, chat.shortId, "new", "Different body");
          expect(retry.status).toBe(200);
          expect(MessageViewSchema.parse(await retry.json()).id).toBe(message.id);
        }
      });

  test("standalone service accounts have no membership on any message path", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    const anchor = MessageViewSchema.parse(await (await send(owner, chat.shortId, "anchor")).json());
    const headers = await f.credential();
    for (const suffix of ["/messages", `/messages/${anchor.id}`, "/changes?afterRev=0"])
      expect((await f.request(headers, `/${chat.shortId}${suffix}`)).status).toBe(404);
    expect((await f.request(headers, `/${chat.shortId}/messages`, "POST", { clientId: "sa", body: "Hello" })).status).toBe(404);
  });

  test("11th send to one chat is limited; retries bypass the limit and add no outbox rows", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    freezeAtWindowStart();
    for (let i = 0; i < 10; i++) expect((await send(owner, chat.shortId, `limit-${i}`)).status).toBe(201);
    const before = await outbox(chat.shortId);
    const response = await f.request({ ...owner.headers, "accept-language": "de" }, `/${chat.shortId}/messages`, "POST", {
      clientId: "limited",
      body: "Limited",
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await response.json()).toEqual({
      code: "RATE_LIMITED",
      message: "Du sendest Nachrichten zu schnell. Versuche es später erneut.",
    });
    expect((await send(owner, chat.shortId, "limit-0", "new body")).status).toBe(200);
    expect(await outbox(chat.shortId)).toEqual(before);
  });

  test("61st send across chats is limited by the person's minute budget", async () => {
    const person = await f.person();
    const owner = { ...person, headers: await f.credential(person) };
    const chats = [];
    for (let i = 0; i < 7; i++) chats.push(await f.fixture(owner));
    freezeAtWindowStart();
    for (let i = 0; i < 60; i++) expect((await send(owner, chats[i % chats.length]!.shortId, `global-${i}`)).status).toBe(201);
    const response = await send(owner, chats[0]!.shortId, "global-61");
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
  });
});
