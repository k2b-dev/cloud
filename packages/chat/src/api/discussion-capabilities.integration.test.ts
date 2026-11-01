import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { assertResourceOpenLink } from "@k2b/cloud/capabilities/testing";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { chatCapabilities } from "../capabilities";
import { DiscussionMessageDataSchema } from "../capability-contracts";
import { changeDiscussionMessage, listDiscussion, postDiscussion, readDiscussionMessage } from "../service/discussions";
import { mockDiscussionCatalog, providerApp } from "../service/discussions.test-fixture";
import { messages } from "../service/messages";
import { messageFixtures, type Person } from "./messages.test-fixture";

const originalOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.test";
afterAll(() => {
  if (originalOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  else process.env.CLOUD_CORE_INTERNAL_ORIGIN = originalOrigin;
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("item discussion capabilities", () => {
  const f = messageFixtures();
  let catalog: ReturnType<typeof mockDiscussionCatalog>;
  beforeEach(() => {
    const app = providerApp("inventory", "collection", "item", "resource.fetch");
    catalog = mockDiscussionCatalog([app]);
  });
  afterEach(() => catalog.mockRestore());
  test("list is read-only; post/reply/replay, content mutation and fresh revocation use one item thread", async () => {
    const author = await f.person("Lea");
    const other = await f.person("Nora");
    const item = { type: "inventory.item" as const, id: crypto.randomUUID() };
    let owner = { type: "inventory.collection" as const, id: crypto.randomUUID() };
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
                  view: {
                    title: input.capabilityId === "resource.fetch" ? "Series planning" : "Planning",
                    permission: input.capabilityId === "resource.fetch" ? "read" : "write",
                    ...(input.capabilityId === "resource.fetch" ? { container: { ref: owner, title: "Planning" } } : {}),
                  },
                }),
                links: [{ rel: "open", href: `/app/inventory/resource/${currentItem.id}` }],
              },
            }
          : { ok: false, error: { code: "NOT_FOUND", status: 404, message: "Denied" } };
      },
    });
    const empty = await listDiscussion({ ref: item, limit: 2 }, context(author, "list"));
    expect(calls).toEqual(["resource.fetch", "collection.read"]);
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
    calls.length = 0;
    const reviewed = await chatCapabilities.actions["discussion.post"].review({ ref: item, body: "First" }, context(author, "review"));
    expect(reviewed.ok).toBe(true);
    expect(calls).toEqual(["resource.fetch", "collection.read"]);
    calls.length = 0;
    const posted = await postDiscussion({ ref: item, body: "First" }, context(author, "post-one"));
    expect(posted.ok).toBe(true);
    expect(calls).toEqual(["resource.fetch", "collection.read"]);
    if (!posted.ok) throw new Error("Expected post");
    assertResourceOpenLink(posted.data);
    const first = DiscussionMessageDataSchema.parse(posted.data.data);
    const [chat] = await sql<
      { short_id: string }[]
    >`SELECT short_id FROM chat.conversations WHERE resource_type = ${owner.type} AND resource_id = ${owner.id}`;
    f.trackChat(chat!.short_id);
    expect(first.via).toBe("assistant");
    const replayed = await postDiscussion({ ref: item, body: "First" }, context(author, "post-one"));
    expect(replayed.ok && replayed.data.data.ref.id).toBe(first.ref.id);
    expect(await postDiscussion({ ref: item, body: "Changed" }, context(author, "post-one"))).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_CONFLICT", status: 409 },
    });
    const reply = await postDiscussion({ ref: item, body: "🦋".repeat(301), replyTo: first.ref.id }, context(other, "reply", "mcp"));
    expect(reply.ok).toBe(true);
    if (!reply.ok) throw new Error("Expected reply");
    expect(reply.data.data.replyTo).toBe(first.ref.id);
    // These direct provider calls bypass Core's expiring claim and exercise the durable replay guard.
    const head = () => sql`SELECT seq_head, rev FROM chat.conversations WHERE short_id = ${chat!.short_id}`;
    const beforeReplays = await head();
    for (const input of [
      { ref: item, body: "Changed", replyTo: first.ref.id },
      { ref: item, body: "🦋".repeat(301) },
      { ref: item, body: "🦋".repeat(301), replyTo: reply.data.data.ref.id },
    ])
      expect(await postDiscussion(input, context(other, "reply", "mcp"))).toMatchObject({
        ok: false,
        error: { code: "IDEMPOTENCY_CONFLICT", status: 409 },
      });
    expect(await postDiscussion({ ref: item, body: "First", replyTo: first.ref.id }, context(author, "post-one"))).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_CONFLICT", status: 409 },
    });
    expect(await head()).toEqual(beforeReplays);
    const page = await listDiscussion({ ref: item, limit: 1 }, context(author, "page"));
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("Expected list");
    expect(page.data.data[0]?.ref.id).toBe(reply.data.data.ref.id);
    expect(page.data.data[0]?.previewTruncated).toBe(true);
    expect(page.data.page?.hasMore).toBe(true);
    if (!page.data.page?.hasMore) throw new Error("Expected next page");
    const older = await listDiscussion({ ref: item, limit: 1, cursor: page.data.page.nextCursor }, context(author, "older"));
    expect(older.ok && older.data.data[0]?.ref.id).toBe(first.ref.id);
    const forbidden = await changeDiscussionMessage("delete", { id: first.ref.id, revision: 0 }, context(other, "foreign-delete"));
    expect(forbidden.ok).toBe(false);
    calls.length = 0;
    const editReview = await chatCapabilities.actions["message.edit"].review(
      { id: first.ref.id, revision: 0, body: "Corrected" },
      context(author, "edit-review"),
    );
    expect(editReview.ok).toBe(true);
    expect(calls).toEqual(["resource.fetch", "collection.read"]);
    calls.length = 0;
    const edited = await changeDiscussionMessage(
      "edit",
      { id: first.ref.id, revision: 0, body: "Corrected" },
      context(author, "mutation", null),
    );
    expect(edited.ok && edited.data.data.via).toBe("assistant");
    expect(calls).toEqual(["resource.fetch", "collection.read"]);
    const postAfterEdit = await postDiscussion({ ref: item, body: "First" }, context(author, "post-one"));
    expect(postAfterEdit.ok && postAfterEdit.data.data.body).toBe("Corrected");
    expect(await postDiscussion({ ref: item, body: "Corrected" }, context(author, "post-one"))).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_CONFLICT", status: 409 },
    });
    const editReplay = await changeDiscussionMessage(
      "edit",
      { id: first.ref.id, revision: 0, body: "Corrected" },
      context(author, "mutation", null),
    );
    expect(editReplay.ok && editReplay.data.data.revision).toBe(1);
    expect((await changeDiscussionMessage("delete", { id: first.ref.id, revision: 0 }, context(author, "stale"))).ok).toBe(false);
    const mcpEdit = await changeDiscussionMessage(
      "edit",
      { id: first.ref.id, revision: 1, body: "From MCP" },
      context(author, "mcp-edit", "mcp"),
    );
    expect(mcpEdit.ok && mcpEdit.data.data.via).toBe("mcp");
    calls.length = 0;
    const deleteReview = await chatCapabilities.actions["message.delete"].review(
      { id: first.ref.id, revision: 2 },
      context(author, "delete-review"),
    );
    expect(deleteReview.ok).toBe(true);
    expect(calls).toEqual(["resource.fetch", "collection.read"]);
    const deleted = await changeDiscussionMessage("delete", { id: first.ref.id, revision: 2 }, context(author, "mutation"));
    expect(deleted.ok && deleted.data.data.body).toBeNull();
    const postAfterDelete = await postDiscussion({ ref: item, body: "First" }, context(author, "post-one"));
    expect(postAfterDelete).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT", status: 409 } });
    const [removed] = await sql<{ client_input_hash: string | null }[]>`
      SELECT client_input_hash FROM chat.messages WHERE short_id = ${first.ref.id}`;
    expect(removed!.client_input_hash).toBeNull();
    expect(await count()).toBe(1);
    const anotherItem = { ...item, id: crypto.randomUUID() };
    const crossItemReply = await postDiscussion(
      { ref: anotherItem, body: "Wrong discussion", replyTo: reply.data.data.ref.id },
      context(author, "cross-item-reply", "assistant", anotherItem),
    );
    expect(crossItemReply.ok).toBe(false);
    const crossItemReplay = await postDiscussion(
      { ref: anotherItem, body: "Different item" },
      context(author, "post-one", "assistant", anotherItem),
    );
    // The original thread is outside this invocation’s exact authorized item.
    expect(!crossItemReplay.ok && crossItemReplay.error.status).toBe(404);
    await sql`UPDATE chat.messages SET created_at = clock_timestamp() - interval '11 minutes' WHERE short_id = ${reply.data.data.ref.id}`;
    const expired = await changeDiscussionMessage(
      "edit",
      { id: reply.data.data.ref.id, revision: 0, body: "Too late" },
      context(other, "expired"),
    );
    expect(!expired.ok && expired.error.code).toBe("MESSAGE_MUTATION_EXPIRED");
    const originalOwner = owner;
    owner = { ...owner, id: crypto.randomUUID() };
    const moved = await readDiscussionMessage({ id: first.ref.id }, context(author, "moved"));
    expect(!moved.ok && moved.error.status).toBe(404);
    owner = originalOwner;
    permitted = false;
    const denied = await readDiscussionMessage({ id: first.ref.id }, context(author, "read-denied"));
    const unknown = await readDiscussionMessage({ id: testShortId(10) }, context(author, "read-unknown"));
    expect(denied).toEqual(unknown);
    expect((await postDiscussion({ ref: item, body: "First" }, context(author, "post-one"))).ok).toBe(false);
    expect(calls.every((id) => id === "resource.fetch" || id === "collection.read")).toBe(true);
    expect(calls.filter((id) => id === "resource.fetch").length).toBeGreaterThan(0);
  });
  test("concurrent post keys compare their inputs after waiting for the conversation lock", async () => {
    const author = await f.person();
    const chat = await f.fixture(author);
    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const holder = sql.begin(async (db) => {
      await db`SELECT id FROM chat.conversations WHERE short_id = ${chat.shortId} FOR UPDATE`;
      const [session] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      locked.resolve(session!.pid);
      await release.promise;
    });
    const holderPid = await locked.promise;
    const sends = Promise.all(
      ["First", "Changed"].map((body) =>
        messages.send({
          ...author.context,
          conversationId: chat.shortId,
          replayHash: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
          input: { clientId: "locked-replay", body },
        }),
      ),
    );
    try {
      const deadline = performance.now() + 3_000; // Real clock bounds waiting for both database sessions.
      while (true) {
        const [waiting] = await sql<{ count: number }[]>`WITH RECURSIVE blocked(pid) AS (
            SELECT ${holderPid}::int
            UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
          ) SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE pid IN (SELECT pid FROM blocked WHERE pid <> ${holderPid}) AND wait_event_type = 'Lock'
            AND query LIKE 'SELECT id FROM chat.conversations WHERE short_id = % FOR UPDATE'`;
        if (waiting!.count === 2) break;
        if (performance.now() >= deadline) throw new Error("Both post attempts did not reach the conversation lock");
        await Bun.sleep(10);
      }
    } finally {
      release.resolve();
      await holder;
      await sends;
    }
    const outcomes = await sends;
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    expect(outcomes.filter((result) => !result.ok)).toMatchObject([{ ok: false, error: { code: "IDEMPOTENCY_CONFLICT", status: 409 } }]);
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
