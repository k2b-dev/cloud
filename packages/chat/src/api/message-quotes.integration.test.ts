import { expect, test } from "bun:test";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
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
    expect(
      (
        await post(ben, chat, {
          quotes: [
            { message: inThread.id, text: "done" },
            { message: source.id, text: "ready" },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await post(ben, chat, { replyTo: source.id, quotes: [{ message: inThread.id, text: "done" }] })).status).toBe(400);
    const other = await thread(lea, chat, "Budget");
    expect((await post(ben, chat, { thread: other, quotes: [{ message: inThread.id, text: "done" }] })).status).toBe(400);

    // Editing the original keeps the quote as it was; deleting it leaves the quote without text.
    const path = `/${chat}/messages/${source.id}`;
    const edited = await f.request(lea.headers, path, "PATCH", { clientId: "edit-quoted", revision: 0, body: "Rewritten." });
    expect(edited.status).toBe(200);
    expect((await read(ben, chat, quoting.id)).quotes?.[0]).toMatchObject({ text: "quarterly report is ready. numbers" });
    const removed = await f.request(lea.headers, path, "DELETE", { clientId: "delete-quoted", revision: 1 });
    expect(removed.status).toBe(200);
    expect((await read(ben, chat, quoting.id)).quotes).toEqual([{ deleted: true }]);
    expect((await read(ben, chat, answer.id)).quotes?.[0]).toMatchObject({ id: inThread.id });
    expect((await post(ben, chat, { quotes: [{ message: source.id, text: "Rewritten" }] })).status).toBe(404);
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
    try {
      const reply = await meter.during(() => send(ben, chat, { replyTo: second.id }));
      const quoted = await meter.during(() =>
        send(ben, chat, {
          replyTo: second.id,
          quotes: [
            { message: first.id, text: "First passage" },
            { message: second.id, text: "Second passage" },
          ],
        }),
      );
      expect(quoted.length).toBe(reply.length);
    } finally {
      await meter.close();
    }
  });
});
