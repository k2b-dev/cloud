import { expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { chatService } from "../service";
import { MessageViewSchema, SEND_CONVERSATION_LIMIT } from "../service/contracts";
import { messageFixtures } from "./messages.test-fixture";

suiteFor(
  "database",
  "nats",
  "valkey",
)("own-message mutations", () => {
  const f = messageFixtures();
  test("edit/delete enforce authorship, revision and expiry, replay safely and erase reply content", async () => {
    const author = await f.person("Lea");
    const other = await f.person("Nora");
    const chat = await f.fixture(author, [{ person: other, permission: "write" }]);
    const send = async (body: string, replyTo?: string) => {
      const response = await f.request(author.headers, `/${chat.shortId}/messages`, "POST", {
        clientId: crypto.randomUUID(),
        body,
        replyTo,
      });
      expect(response.status).toBe(201);
      return MessageViewSchema.parse(await response.json());
    };
    const original = await send("Original https://example.test/");
    const reply = await send("Reply", original.id);
    const path = `/${chat.shortId}/messages/${original.id}`;
    const patch = { clientId: "edit-one", revision: original.contentRevision ?? 0, body: "Corrected" };
    expect((await f.request(other.headers, path, "PATCH", patch)).status).toBe(403);
    const edited = await f.request(author.headers, path, "PATCH", patch);
    expect(edited.status).toBe(200);
    const view = MessageViewSchema.parse(await edited.json());
    expect(view.body).toBe("Corrected");
    expect(view.editedAt).toBeTruthy();
    expect((await f.request(author.headers, path, "PATCH", patch)).status).toBe(200);
    expect((await f.request(author.headers, path, "PATCH", { ...patch, body: "Another" })).status).toBe(409);
    expect((await f.request(author.headers, path, "PATCH", { ...patch, clientId: "stale" })).status).toBe(409);
    // Reactions raise the stream revision, but cannot conflict with the author's content edit.
    await sql`UPDATE chat.messages SET rev = rev + 1 WHERE short_id = ${original.id}`;
    const deletion = { clientId: "delete-one", revision: view.contentRevision ?? 0 };
    const removed = await f.request(author.headers, path, "DELETE", deletion);
    expect(removed.status).toBe(200);
    const tombstone = MessageViewSchema.parse(await removed.json());
    expect(tombstone.body).toBeNull();
    expect(tombstone.deletedAt).toBeTruthy();
    expect(tombstone.refs).toEqual([]);
    expect(tombstone.attachments).toEqual([]);
    expect((await f.request(author.headers, path, "DELETE", deletion)).status).toBe(200);
    const quoted = await f.request(author.headers, `/${chat.shortId}/messages/${reply.id}`);
    expect(MessageViewSchema.parse(await quoted.json()).replyTo).toEqual({ deleted: true });
    const deletedReply = await f.request(author.headers, `/${chat.shortId}/messages/${reply.id}`, "DELETE", {
      clientId: "delete-reply",
      revision: reply.contentRevision ?? 0,
    });
    expect(deletedReply.status).toBe(200);
    // Tombstones must never reach text-only sidebar, thread or For You previews.
    expect((await chatService.threads.list({ ...author.context, conversationId: chat.shortId })).ok).toBe(true);
    expect((await chatService.messages.snapshot({ ...author.context, conversationId: chat.shortId })).ok).toBe(true);
    expect((await chatService.conversations.list(author.context)).ok).toBe(true);
    const incoming = await f.request(other.headers, `/${chat.shortId}/messages`, "POST", {
      clientId: "incoming-reply",
      body: "Reply for Lea",
      replyTo: original.id,
    });
    // A tombstone can no longer receive a new reply.
    expect(incoming.status).toBe(404);
    // Even a rate-limited retry must return its committed receipt.
    for (let attempt = 0; attempt < SEND_CONVERSATION_LIMIT; attempt++)
      expect((await f.request(author.headers, path, "DELETE", deletion)).status).toBe(200);
    expect((await f.request(author.headers, path, "DELETE", { ...deletion, clientId: "new-limited" })).status).toBe(429);
  });
  test("deleted replies disappear from For You, and expired or read-only mutations fail", async () => {
    const author = await f.person("Lea");
    const other = await f.person("Nora");
    const chat = await f.fixture(author, [{ person: other, permission: "write" }]);
    const send = async (body: string) => {
      const response = await f.request(author.headers, `/${chat.shortId}/messages`, "POST", { clientId: crypto.randomUUID(), body });
      expect(response.status).toBe(201);
      return MessageViewSchema.parse(await response.json());
    };
    const target = await send("Reply to this");
    const addressed = await f.request(other.headers, `/${chat.shortId}/messages`, "POST", {
      clientId: "other-reply",
      body: "Reply for Lea",
      replyTo: target.id,
    });
    const addressedMessage = MessageViewSchema.parse(await addressed.json());
    expect(
      (
        await f.request(other.headers, `/${chat.shortId}/messages/${addressedMessage.id}`, "DELETE", {
          clientId: "remove-addressed",
          revision: addressedMessage.contentRevision ?? 0,
        })
      ).status,
    ).toBe(200);
    const forYou = await chatService.forYou.list(author.context);
    expect(forYou.ok).toBe(true);
    if (forYou.ok) expect(forYou.data.items.some((item) => item.message.id === addressedMessage.id)).toBe(false);
    const aged = await send("Old message");
    await sql`UPDATE chat.messages SET created_at = clock_timestamp() - interval '10 minutes' WHERE short_id = ${aged.id}`;
    expect(
      (
        await f.request(author.headers, `/${chat.shortId}/messages/${aged.id}`, "DELETE", {
          clientId: "old",
          revision: aged.contentRevision ?? 0,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.request(await f.credential(author), `/${chat.shortId}/messages/${aged.id}`, "DELETE", {
          clientId: "read-only",
          revision: aged.contentRevision ?? 0,
        })
      ).status,
    ).toBe(403);
  });
});
