import { expect, test } from "bun:test";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { readMessage } from "../service/capability-reads";
import { MAX_MESSAGE_REFS, MessageViewSchema, ThreadSchema } from "../service/contracts";
import { messageFixtures, type Person } from "./messages.test-fixture";

suiteFor(
  "database",
  "nats",
  "valkey",
)("quoted passages", () => {
  const f = messageFixtures();
  const post = (person: Person, chat: string, input: Record<string, unknown>) =>
    f.request(person.headers, `/${chat}/messages`, "POST", { clientId: crypto.randomUUID(), body: "Answer", ...input });
  const send = async (person: Person, chat: string, input: Record<string, unknown>) => {
    const response = await post(person, chat, input);
    expect(response.status).toBe(201);
    return MessageViewSchema.parse(await response.json());
  };
  const read = async (person: Person, chat: string, id: string) =>
    MessageViewSchema.parse(await (await f.request(person.headers, `/${chat}/messages/${id}`)).json());
  const thread = async (person: Person, chat: string, name: string) => {
    const response = await f.request(person.headers, `/${chat}/threads`, "POST", { name });
    expect(response.status).toBe(201);
    return ThreadSchema.parse(await response.json()).id;
  };

  test("a quote must occur in its message, lives in one thread with the reply, and is stored as a snapshot", async () => {
    const lea = await f.person("Lea Muster");
    const ben = await f.person("Ben Schulz");
    const chat = (await f.fixture(lea, [{ person: ben, permission: "write" }])).shortId;
    const source = await send(lea, chat, { body: "The **quarterly report** is ready.\n\n- numbers\n- slides" });

    const quoting = await send(ben, chat, { quotes: [{ message: source.id, text: "  quarterly report is\n ready. numbers " }] });
    expect(quoting.thread).toBeNull();
    expect(quoting.quotes).toEqual([
      { id: source.id, author: { type: "user", id: lea.id, name: "Lea Muster" }, text: "quarterly report is ready. numbers" },
    ]);
    // An invented passage, an empty one, a missing message and too many quotes are refused.
    expect((await post(ben, chat, { quotes: [{ message: source.id, text: "report is late" }] })).status).toBe(400);
    expect((await post(ben, chat, { quotes: [{ message: source.id, text: " \n " }] })).status).toBe(400);
    expect((await post(ben, chat, { quotes: [{ message: "ZZZZZZZZZZ", text: "ready" }] })).status).toBe(404);
    const many = Array.from({ length: MAX_MESSAGE_REFS + 1 }, () => ({ message: source.id, text: "ready" }));
    expect((await post(ben, chat, { quotes: many })).status).toBe(400);
    const long = Array.from({ length: 2 }, () => ({ message: source.id, text: "x".repeat(10_001) }));
    expect((await post(ben, chat, { quotes: long })).status).toBe(400);

    // Without a target, the message goes to its sources' thread; a different thread or mixed sources are refused.
    const planning = await thread(lea, chat, "Planning");
    const inThread = await send(lea, chat, { thread: planning, body: "Slides for Friday are done." });
    const answer = await send(ben, chat, { quotes: [{ message: inThread.id, text: "Slides for Friday" }] });
    expect(answer.thread).toBe(planning);
    expect((await post(ben, chat, { thread: planning, quotes: [{ message: inThread.id, text: "done" }] })).status).toBe(201);
    // Sources from several threads can never form one message: the answer of a missing message, before any read check.
    expect(
      (
        await post(ben, chat, {
          quotes: [
            { message: inThread.id, text: "done" },
            { message: source.id, text: "ready" },
          ],
        })
      ).status,
    ).toBe(404);
    expect((await post(ben, chat, { replyTo: source.id, quotes: [{ message: inThread.id, text: "done" }] })).status).toBe(404);
    const other = await thread(lea, chat, "Budget");
    expect((await post(ben, chat, { thread: other, quotes: [{ message: inThread.id, text: "done" }] })).status).toBe(400);

    // An edit that keeps the quoted words keeps the quote; one that takes them away leaves it without text.
    const path = `/${chat}/messages/${source.id}`;
    const kept = await f.request(lea.headers, path, "PATCH", {
      clientId: "edit-kept",
      revision: 0,
      body: "The **quarterly report** is ready.\n\n- numbers\n- charts",
    });
    expect(kept.status).toBe(200);
    expect((await read(ben, chat, quoting.id)).quotes?.[0]).toMatchObject({ text: "quarterly report is ready. numbers" });
    const edited = await f.request(lea.headers, path, "PATCH", { clientId: "edit-quoted", revision: 1, body: "Rewritten." });
    expect(edited.status).toBe(200);
    expect((await read(ben, chat, quoting.id)).quotes).toEqual([{ deleted: true }]);
    expect((await read(ben, chat, answer.id)).quotes?.[0]).toMatchObject({ id: inThread.id });
    const removed = await f.request(lea.headers, path, "DELETE", { clientId: "delete-quoted", revision: 2 });
    expect(removed.status).toBe(200);
    expect((await post(ben, chat, { quotes: [{ message: source.id, text: "Rewritten" }] })).status).toBe(404);
  });

  test("after an edit or a deletion takes the words away, no read API returns the old passage", async () => {
    const lea = await f.person("Lea Muster");
    const ben = await f.person("Ben Schulz");
    const chat = (await f.fixture(lea, [{ person: ben, permission: "write" }])).shortId;
    const edited = await send(lea, chat, { body: "The secret plan is Friday." });
    const deleted = await send(lea, chat, { body: "Lunch at noon in the hall." });
    const stays = await send(lea, chat, { body: "Kept words stay here." });
    const quotesEdited = await send(ben, chat, { body: "First answer", quotes: [{ message: edited.id, text: "secret plan is Friday" }] });
    const quotesDeleted = await send(ben, chat, { body: "Second answer", quotes: [{ message: deleted.id, text: "Lunch at noon" }] });
    const quotesStays = await send(ben, chat, { body: "Third answer", quotes: [{ message: stays.id, text: "Kept words" }] });
    const before = Math.max(quotesEdited.rev, quotesDeleted.rev, quotesStays.rev);
    const change = (message: { id: string; contentRevision?: number }, method: "PATCH" | "DELETE", body?: string) =>
      f.request(lea.headers, `/${chat}/messages/${message.id}`, method, {
        clientId: crypto.randomUUID(),
        revision: message.contentRevision ?? 0,
        ...(body ? { body } : {}),
      });
    expect((await change(edited, "PATCH", "The plan moved to next week.")).status).toBe(200);
    expect((await change(stays, "PATCH", "Kept words stay here, and more.")).status).toBe(200);
    expect((await change(deleted, "DELETE")).status).toBe(200);

    const gone = ["secret plan is Friday", "Lunch at noon"];
    const reads: [string, string][] = [];
    for (const path of [
      "/messages",
      `/changes?afterRev=${before}`,
      "/snapshot",
      `/messages/${quotesEdited.id}`,
      `/messages/${quotesDeleted.id}`,
      `/messages/${quotesStays.id}`,
    ]) {
      const response = await f.request(ben.headers, `/${chat}${path}`);
      expect(response.status).toBe(200);
      reads.push([path, await response.text()]);
    }
    const capability = {
      actor: ben.context.actor,
      accessSubject: ben.context.accessSubject,
      user: ben.context.actor.kind === "user" ? ben.context.actor.user : null,
      locale: "en",
      requestId: "quote-reads",
      origin: "http" as const,
      via: null,
      signal: new AbortController().signal,
    };
    for (const id of [quotesEdited.id, quotesDeleted.id, quotesStays.id]) {
      const result = await readMessage({ id }, capability);
      expect(result.ok).toBe(true);
      reads.push([`chat.message.read ${id}`, JSON.stringify(result)]);
    }
    for (const [where, text] of reads)
      for (const words of gone) expect(text.includes(words), `${where} still holds "${words}"`).toBe(false);
    expect(reads.find(([where]) => where === `/messages/${quotesStays.id}`)![1]).toContain("Kept words");

    // The change feed carries each quoting message again, with a revision of its own, so a client that follows it
    // drops the old words too.
    const changes = await (await f.request(ben.headers, `/${chat}/changes?afterRev=${before}`)).json();
    const changed = (changes as { messages: { id: string; rev: number; quotes?: unknown[] }[] }).messages;
    const again = changed.filter((message) => message.id === quotesEdited.id || message.id === quotesDeleted.id);
    expect(again.map((message) => message.quotes)).toEqual([[{ deleted: true }], [{ deleted: true }]]);
    expect(new Set(again.map((message) => message.rev)).size).toBe(2);
    expect(again.every((message) => message.rev > before)).toBe(true);
    expect(changed.some((message) => message.id === quotesStays.id)).toBe(false);
  });

  test("the answered and the quoted messages load in the reply's one statement", async () => {
    const lea = await f.person("Lea Muster");
    const ben = await f.person("Ben Schulz");
    const chat = (await f.fixture(lea, [{ person: ben, permission: "write" }])).shortId;
    const first = await send(lea, chat, { body: "First passage to quote." });
    const second = await send(lea, chat, { body: "Second passage to quote." });
    // Warm both paths, so caches and prepared statements match.
    await send(ben, chat, { replyTo: second.id });
    await send(ben, chat, { replyTo: second.id, quotes: [{ message: first.id, text: "First passage" }] });
    const meter = await meterSql();
    // A send wakes notification and event work after its commit; it runs on other connections and would land in
    // whichever window is open. Wait until the process is quiet, then compare the send's own transaction.
    const quiet = async () => {
      for (let round = 0; round < 50; round++) if ((await meter.during(() => Bun.sleep(300))).length === 0) return; // real clock: background work settles
      throw new Error("Background statements did not settle");
    };
    const transaction = (statements: string[]) => {
      const start = statements.findIndex((statement) => /^BEGIN/i.test(statement));
      const end = statements.findIndex((statement, index) => index > start && /^COMMIT/i.test(statement));
      return start < 0 || end < 0 ? statements : statements.slice(start, end + 1);
    };
    try {
      await quiet();
      const reply = transaction(await meter.during(() => send(ben, chat, { replyTo: second.id })));
      await quiet();
      const quoted = transaction(
        await meter.during(() =>
          send(ben, chat, {
            replyTo: second.id,
            quotes: [
              { message: first.id, text: "First passage" },
              { message: second.id, text: "Second passage" },
            ],
          }),
        ),
      );
      // The same statements in the same order: the sources come with the answered message, nothing more.
      expect(quoted).toEqual(reply);
    } finally {
      await meter.close();
    }
  });

  test("sources from several threads are refused before any read check, like a missing message (DATA-13)", async () => {
    const lea = await f.person("Lea Muster");
    const ben = await f.person("Ben Schulz");
    const chat = (await f.fixture(lea, [{ person: ben, permission: "write" }])).shortId;
    const quotes: { message: string; text: string }[] = [];
    for (const name of ["Planning", "Budget", "Travel"]) {
      const id = await thread(lea, chat, name);
      const message = await send(lea, chat, { thread: id, body: `${name} notes are ready.` });
      quotes.push({ message: message.id, text: "notes are ready" });
    }
    const missing = [{ message: "ZZZZZZZZZZ", text: "notes are ready" }];
    // Warm both paths, so caches and prepared statements match.
    expect((await post(ben, chat, { quotes })).status).toBe(404);
    expect((await post(ben, chat, { quotes: missing })).status).toBe(404);
    const meter = await meterSql();
    const statements = (log: string[]) => log.filter((statement) => !/^(LISTEN|UNLISTEN|NOTIFY)/i.test(statement));
    try {
      const mixed = await meter.during(async () => expect((await post(ben, chat, { quotes })).status).toBe(404));
      const unknown = await meter.during(async () => expect((await post(ben, chat, { quotes: missing })).status).toBe(404));
      // No thread lookup or provider read for any source: the same statements as for a message that does not exist.
      expect(statements(mixed)).toEqual(statements(unknown));
    } finally {
      await meter.close();
    }
  });
});
