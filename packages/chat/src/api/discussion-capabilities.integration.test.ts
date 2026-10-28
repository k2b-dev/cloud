import { expect, test } from "bun:test";
import { assertResourceOpenLink } from "@k2b/cloud/capabilities/testing";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { DiscussionMessageDataSchema } from "../capability-contracts";
import { changeDiscussionMessage, listDiscussion, postDiscussion, readDiscussionMessage } from "../service/discussions";
import { messageFixtures, type Person } from "./messages.test-fixture";

suiteFor(
  "database",
  "nats",
  "valkey",
)("item discussion capabilities", () => {
  const f = messageFixtures();
  test("list is read-only; post/reply/replay, content mutation and fresh revocation use one item thread", async () => {
    const author = await f.person("Lea");
    const other = await f.person("Nora");
    const item = { type: "spaces.item" as const, id: testShortId() };
    let owner = { type: "spaces.space" as const, id: testShortId() };
    let permitted = true;
    const calls: string[] = [];
    const context = (
      person: Person,
      key: string,
      via: "assistant" | "mcp" | null = "assistant",
      currentItem = item,
    ): CapabilityExecutionContext => ({
      actor: person.context.actor,
      accessSubject: person.context.accessSubject,
      user: person.context.actor.kind === "user" ? person.context.actor.user : null,
      locale: "en",
      requestId: "discussion-integration",
      origin: via ?? "http",
      via,
      idempotencyKey: key,
      signal: new AbortController().signal,
      query: async (input, schema) => {
        calls.push(input.capabilityId);
        return permitted
          ? {
              ok: true,
              data: {
                data: schema.parse({
                  id: currentItem.id,
                  title: "Series planning",
                  kind: "event",
                  spaceId: owner.id,
                  container: { ref: owner, name: "Planning", permission: "write" },
                }),
                links: [{ rel: "open", href: `/app/spaces/${owner.id}/items/${currentItem.id}` }],
              },
            }
          : { ok: false, error: { code: "NOT_FOUND", status: 404, message: "Denied" } };
      },
    });
    const empty = await listDiscussion({ item, limit: 2 }, context(author, "list"));
    expect(empty).toEqual({ ok: true, data: { data: [], page: { hasMore: false } } });
    const count = async () =>
      Number(
        (
          await sql<
            { count: string }[]
          >`SELECT count(*) FROM chat.conversations WHERE resource_type = ${owner.type} AND resource_id = ${owner.id}`
        )[0]!.count,
      );
    expect(await count()).toBe(0);
    const posted = await postDiscussion({ item, body: "First" }, context(author, "post-one"));
    expect(posted.ok).toBe(true);
    if (!posted.ok) throw new Error("Expected post");
    assertResourceOpenLink(posted.data);
    const first = DiscussionMessageDataSchema.parse(posted.data.data);
    const [chat] = await sql<
      { short_id: string }[]
    >`SELECT short_id FROM chat.conversations WHERE resource_type = ${owner.type} AND resource_id = ${owner.id}`;
    f.trackChat(chat!.short_id);
    expect(first.via).toBe("assistant");
    const replayed = await postDiscussion({ item, body: "First" }, context(author, "post-one"));
    expect(replayed.ok && replayed.data.data.ref.id).toBe(first.ref.id);
    const reply = await postDiscussion({ item, body: "🦋".repeat(301), replyTo: first.ref.id }, context(other, "reply", "mcp"));
    expect(reply.ok).toBe(true);
    if (!reply.ok) throw new Error("Expected reply");
    expect(reply.data.data.replyTo).toBe(first.ref.id);
    const page = await listDiscussion({ item, limit: 1 }, context(author, "page"));
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("Expected list");
    expect(page.data.data[0]?.ref.id).toBe(reply.data.data.ref.id);
    expect(page.data.data[0]?.previewTruncated).toBe(true);
    expect(page.data.page?.hasMore).toBe(true);
    if (!page.data.page?.hasMore) throw new Error("Expected next page");
    const older = await listDiscussion({ item, limit: 1, cursor: page.data.page.nextCursor }, context(author, "older"));
    expect(older.ok && older.data.data[0]?.ref.id).toBe(first.ref.id);
    const forbidden = await changeDiscussionMessage("delete", { id: first.ref.id, revision: 0 }, context(other, "foreign-delete"));
    expect(forbidden.ok).toBe(false);
    const edited = await changeDiscussionMessage(
      "edit",
      { id: first.ref.id, revision: 0, body: "Corrected" },
      context(author, "mutation", null),
    );
    expect(edited.ok && edited.data.data.via).toBe("assistant");
    const editReplay = await changeDiscussionMessage(
      "edit",
      { id: first.ref.id, revision: 0, body: "Corrected" },
      context(author, "mutation", null),
    );
    expect(editReplay.ok && editReplay.data.data.revision).toBe(1);
    expect((await changeDiscussionMessage("delete", { id: first.ref.id, revision: 0 }, context(author, "stale"))).ok).toBe(false);
    const deleted = await changeDiscussionMessage("delete", { id: first.ref.id, revision: 1 }, context(author, "mutation"));
    expect(deleted.ok && deleted.data.data.body).toBeNull();
    expect(await count()).toBe(1);
    const anotherItem = { ...item, id: testShortId() };
    const crossItemReply = await postDiscussion(
      { item: anotherItem, body: "Wrong discussion", replyTo: reply.data.data.ref.id },
      context(author, "cross-item-reply", "assistant", anotherItem),
    );
    expect(crossItemReply.ok).toBe(false);
    const crossItemReplay = await postDiscussion(
      { item: anotherItem, body: "Different item" },
      context(author, "post-one", "assistant", anotherItem),
    );
    expect(!crossItemReplay.ok && crossItemReplay.error.code).toBe("IDEMPOTENCY_CONFLICT");
    await sql`UPDATE chat.messages SET created_at = clock_timestamp() - interval '11 minutes' WHERE short_id = ${reply.data.data.ref.id}`;
    const expired = await changeDiscussionMessage(
      "edit",
      { id: reply.data.data.ref.id, revision: 0, body: "Too late" },
      context(other, "expired"),
    );
    expect(!expired.ok && expired.error.code).toBe("MESSAGE_MUTATION_EXPIRED");
    const originalOwner = owner;
    owner = { ...owner, id: testShortId() };
    const moved = await readDiscussionMessage({ id: first.ref.id }, context(author, "moved"));
    expect(!moved.ok && moved.error.status).toBe(404);
    owner = originalOwner;
    permitted = false;
    const denied = await readDiscussionMessage({ id: first.ref.id }, context(author, "read-denied"));
    const unknown = await readDiscussionMessage({ id: testShortId(10) }, context(author, "read-unknown"));
    expect(denied).toEqual(unknown);
    expect((await postDiscussion({ item, body: "First" }, context(author, "post-one"))).ok).toBe(false);
    expect(calls.every((id) => id === "item.read")).toBe(true);
  });
  test("the message reader rejects general-chat messages", async () => {
    const person = await f.person();
    const chat = await f.fixture(person);
    const response = await f.request(person.headers, `/${chat.shortId}/messages`, "POST", {
      clientId: "general",
      body: "Private general chat",
    });
    const message = await response.json();
    let queried = false;
    const result = await readDiscussionMessage(
      { id: message.id },
      {
        actor: person.context.actor,
        accessSubject: person.context.accessSubject,
        user: null,
        locale: "en",
        requestId: "general-reader",
        origin: "http",
        signal: new AbortController().signal,
        query: async () => {
          queried = true;
          throw new Error("Must not query");
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(queried).toBe(false);
  });
});
