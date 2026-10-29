import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { reviewFixture } from "../../_internal/capability-review.test-fixture";
import { migrateCloudAi } from "../../ai/migrate";
import { aiConversations, recordAiToolReview } from "../../ai/store";
import { createDeviceActions } from "../../api/app-approval-actions";
import { APPROVALS_PAGE_SIZE } from "../../contracts/approvals";
import { CAPABILITY_MAX_REVIEW_CONTENT_BYTES } from "../../contracts/capabilities";
import { type ApprovalRequestInput, approvalReviewDigest, approvals, countPending, listPending, presentPendingApproval } from ".";
import { readApprovalContent } from "./content";

const insertUser = async () => {
  const uid = `approval-list-${crypto.randomUUID()}`;
  const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,mail)
    VALUES(${uid},'local','user',${`${uid}@example.test`}) RETURNING id`;
  if (!user) throw new Error("Missing fixture user");
  return user.id;
};

databaseSuite()("pending approval lists", () => {
  const users: string[] = [];
  beforeAll(migrateCloudAi);
  afterAll(async () => {
    for (const userId of users) await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
  });
  const fixture = async () => {
    const userId = await insertUser();
    users.push(userId);
    const chat = await aiConversations.createConversation({ ownerUserId: userId, title: "Write a letter" });
    const { turn } = await aiConversations.submitChatTurn({
      conversationId: chat.id,
      modelId: "mock",
      runConfig: { kind: "chat", input: "Write a letter" },
      userMessage: { role: "user", content: [{ type: "text", text: "Write a letter" }] },
    });
    const ask = async (extra: Partial<ApprovalRequestInput> = {}, linked = true) => {
      const callId = crypto.randomUUID();
      const input: ApprovalRequestInput = {
        appId: "mail",
        action: "draft.send",
        requester: { kind: "assistant_turn", appId: "assistant", ref: `${turn.id}/${callId}` },
        subjectId: userId,
        approverUserId: userId,
        assurance: "standard",
        sentence: "Mail: Send draft",
        input: {},
        expiresInMs: 600_000,
        review: { message: "Send draft?", links: [{ rel: "open", title: "Draft", href: "/app/mail?draft=one" }] },
        ...extra,
      };
      const request = await approvals.request(input);
      if (!request.ok) throw new Error("Missing approval");
      if (linked)
        await aiConversations.savePendingTurnAction({
          approvalId: request.id,
          conversationId: chat.id,
          turnId: turn.id,
          callId,
          kind: "approval",
          status: "pending",
          name: "mail.draft.send",
          args: {},
          allowAlways: true,
          allowChat: true,
          approvalScope: "draft",
          resolvedEvent: null,
        });
      return request.id;
    };
    return { userId, chat, turn, ask };
  };

  test("full approval content round-trips JSONB with exact approver, digest, expiry and epoch checks", async () => {
    const { userId, ask } = await fixture();
    const other = await fixture();
    const content = { kind: "page" as const, title: "Draft", body: `${"x".repeat(65_536)}\u0000\ud800END\udc00`, format: "plain" as const };
    const review = { ...reviewFixture(), preview: { ...content, body: "Short" }, content };
    const id = await ask({ review });
    const digest = approvalReviewDigest(review);
    expect((await approvals.get(id))?.details).toEqual(review);
    expect(await readApprovalContent({ id, digest, approverUserId: userId })).toEqual(content);
    expect(await readApprovalContent({ id, digest, approverUserId: other.userId })).toBeNull();
    expect(await readApprovalContent({ id, digest: "0".repeat(64), approverUserId: userId })).toBeNull();
    expect(JSON.stringify(await listPending({ approverUserId: userId }))).not.toContain("x".repeat(1_000));
    await sql`UPDATE approvals.requests SET approver_auth_epoch=approver_auth_epoch+1 WHERE id=${id}::uuid`;
    expect(await readApprovalContent({ id, digest, approverUserId: userId })).toBeNull();
    const expired = await ask({ review, expiresInMs: -1 });
    expect(await readApprovalContent({ id: expired, digest, approverUserId: userId })).toBeNull();
    for (const approved of [false, true]) {
      const decided = await ask({ review });
      expect(await readApprovalContent({ id: decided, digest, approverUserId: userId })).toEqual(content);
      expect(await approvals.decide(decided, { approved }, { userId, via: "web_session" })).toMatchObject({
        ok: true,
        status: approved ? "approved" : "rejected",
      });
      expect(await readApprovalContent({ id: decided, digest, approverUserId: userId })).toBeNull();
    }
    const unlinked = await ask({ review }, false);
    expect(await readApprovalContent({ id: unlinked, digest, approverUserId: userId })).toBeNull();
  });

  test("the exact 16 MiB escaped content budget survives the authorized JSONB reader and compact list", async () => {
    const { userId, ask } = await fixture();
    const empty = { kind: "page" as const, title: "Complete", body: "", format: "plain" as const };
    const remaining = CAPABILITY_MAX_REVIEW_CONTENT_BYTES - Buffer.byteLength(JSON.stringify(empty));
    // Quotes take two bytes in public JSON and expand again in the existing JSONB string encoding.
    const content = { ...empty, body: '"'.repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2) };
    expect(Buffer.byteLength(JSON.stringify(content))).toBe(CAPABILITY_MAX_REVIEW_CONTENT_BYTES);
    const review = { ...reviewFixture(), content };
    const id = await ask({ review });
    const digest = approvalReviewDigest(review);
    expect(await readApprovalContent({ id, digest, approverUserId: userId })).toEqual(content);
    const listed = JSON.stringify(await listPending({ approverUserId: userId }));
    expect(listed.length).toBeLessThan(32 * 1024);
    expect(listed).toContain(digest);
    expect(listed).not.toContain(content.body.slice(0, 1_000));
  }, 30_000);

  test("filters owner, requester and exact review links, and excludes requests nobody can continue", async () => {
    const { userId, chat, turn, ask } = await fixture();
    const owner = await ask();
    await aiConversations.savePendingTurnAction({
      approvalId: owner,
      conversationId: chat.id,
      turnId: turn.id,
      callId: "second-relay",
      kind: "approval",
      status: "pending",
      name: "mail.draft.send",
      args: {},
      allowAlways: false,
      approvalScope: "draft",
      resolvedEvent: null,
    });
    const requester = await ask({ appId: "contacts", requester: { kind: "studio_app", appId: "mail", ref: crypto.randomUUID() } });
    const sameApp = await ask({ appId: "mail", requester: { kind: "assistant_turn", appId: "mail", ref: crypto.randomUUID() } });
    const elsewhere = await ask({ appId: "spaces", review: null });
    expect((await approvals.get(elsewhere, undefined, true))?.details).toBeNull();
    const expired = await ask();
    await sql`UPDATE approvals.requests SET expires_at=now()-interval '1 second' WHERE id=${expired}::uuid`;
    const cancelled = await ask();
    await approvals.cancel([cancelled]);
    await ask({ requester: { kind: "studio_app", appId: "assistant", ref: crypto.randomUUID() } }, false);
    const resolved = await ask();
    await sql`UPDATE ai.pending_actions SET status='resolved' WHERE approval_id=${resolved}::uuid`;
    const other = await fixture();
    await other.ask();
    const query = { approverUserId: userId };
    expect((await listPending(query)).items.map((row) => row.id).sort()).toEqual([owner, requester, sameApp, elsewhere].sort());
    const mail = await listPending({ ...query, appId: "mail" });
    expect(mail.items.map((row) => row.id).sort()).toEqual([owner, requester, sameApp].sort());
    expect(mail).toMatchObject({ count: 3, elsewhere: 1 });
    expect(await listPending({ ...query, appId: "missing" })).toMatchObject({ items: [], count: 0, elsewhere: 4 });
    expect(await listPending({ ...query, appId: "mail", link: "/app/mail?draft=one" })).toMatchObject({ count: 3, elsewhere: 1 });
    expect(await listPending({ ...query, link: "/app/mail?draft=on" })).toMatchObject({ items: [], count: 0, elsewhere: 4 });
    expect(await listPending(query)).toMatchObject({ count: 4, elsewhere: 0 });
    expect(await countPending(query)).toEqual({ total: 4, apps: { mail: 3, assistant: 2, contacts: 1, spaces: 1 } });
    const row = mail.items.find((row) => row.id === requester)!;
    expect(presentPendingApproval(row, []).requester).toMatchObject({ kind: "chat", title: "Write a letter", appId: "mail" });
  });

  test("signing out everywhere removes open requests from counts and Cloud Login until a fresh request", async () => {
    const { userId, ask } = await fixture();
    const stale = await ask();
    const query = { approverUserId: userId };
    const deviceActions = createDeviceActions((appId) => appId);
    const deviceQuery = { userId, issuer: "https://cloud.example.test" };
    expect(await listPending(query)).toMatchObject({ items: [{ id: stale }], count: 1 });
    expect((await deviceActions.inbox(deviceQuery)).actions).toHaveLength(1);
    expect(await deviceActions.view({ ...deviceQuery, actionId: stale })).not.toBeNull();
    await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${userId}::uuid`;
    expect(await listPending(query)).toMatchObject({ items: [], count: 0, elsewhere: 0 });
    expect(await countPending(query)).toEqual({ total: 0, apps: {} });
    expect(await deviceActions.inbox(deviceQuery)).toEqual({ actions: [], moreActions: 0 });
    expect(await deviceActions.view({ ...deviceQuery, actionId: stale })).toBeNull();
    expect(await approvals.get(stale)).toMatchObject({ status: "pending" });
    const fresh = await ask();
    expect(await listPending(query)).toMatchObject({ items: [{ id: fresh }], count: 1 });
    expect(await countPending(query)).toMatchObject({ total: 1 });
    expect((await deviceActions.inbox(deviceQuery)).actions).toHaveLength(1);
    expect(await deviceActions.view({ ...deviceQuery, actionId: fresh })).not.toBeNull();
  });

  test("keyset pages remain newest-first with microsecond timestamps and count across all pages", async () => {
    const { userId, ask } = await fixture();
    const ids: string[] = [];
    for (let i = 0; i < APPROVALS_PAGE_SIZE + 3; i++) {
      const id = await ask();
      ids.push(id);
      // Deliberately use sub-millisecond timestamps; a JS Date cursor would lose the page boundary.
      await sql`UPDATE approvals.requests SET created_at='2026-10-11T00:00:00.123000Z'::timestamptz + (${i} * interval '1 microsecond') WHERE id=${id}::uuid`;
    }
    const first = await listPending({ approverUserId: userId });
    expect(first.items.map((row) => row.id)).toEqual(ids.slice(3).reverse());
    expect(first.count).toBe(23);
    expect(first.nextCursor).not.toBeNull();
    const second = await listPending({ approverUserId: userId, cursor: first.nextCursor! });
    expect(second.items.map((row) => row.id)).toEqual(ids.slice(0, 3).reverse());
    expect(second).toMatchObject({ count: 23, elsewhere: 0, nextCursor: null });
    await expect(listPending({ approverUserId: userId, limit: 21 })).rejects.toThrow("page size");
    await expect(listPending({ approverUserId: userId, cursor: "invalid" })).rejects.toThrow("cursor");
    await sql`UPDATE approvals.requests SET created_at='2026-10-11T00:00:00.123456Z' WHERE approver_user_id=${userId}::uuid`;
    const tied = await listPending({ approverUserId: userId });
    const tiedNext = await listPending({ approverUserId: userId, cursor: tied.nextCursor! });
    expect([...tied.items, ...tiedNext.items].map((row) => row.id)).toEqual([...ids].sort().reverse());
  });

  test("remember options come from the linked action and turn, with confirm always asking", async () => {
    const { userId, turn, ask } = await fixture();
    const standard = await ask();
    const confirm = await ask({ assurance: "confirm" });
    await sql`UPDATE ai.pending_actions SET allow_always=false,allow_chat=true,remember_tool_name='website:read' WHERE approval_id=${standard}::uuid`;
    const options = async (id: string) =>
      presentPendingApproval((await listPending({ approverUserId: userId })).items.find((row) => row.id === id)!, []).remember;
    expect(await options(standard)).toEqual({ chat: true, always: false, website: true });
    expect(await options(confirm)).toEqual({ chat: false, always: false, website: false });
    await sql`UPDATE ai.turns SET run_config=run_config || '{"mandate":{}}'::jsonb WHERE id=${turn.id}::uuid`;
    expect(await options(standard)).toEqual({ chat: false, always: false, website: true });
  });

  test.each(["ai.messages", "ai.task_messages"])(
    "reads the pending call's stored review from %s without changing approval details",
    async (table) => {
      const { userId, chat, turn, ask } = await fixture();
      const review = reviewFixture();
      const id = await ask({ review });
      const query = { approverUserId: userId, id };
      const before = (await listPending(query)).items[0]!;
      expect(before.storedReview).toBeNull();
      const [pending] = await sql<{ callId: string }[]>`SELECT call_id AS "callId" FROM ai.pending_actions WHERE approval_id=${id}::uuid`;
      if (!pending) throw new Error("Missing pending call");
      const store = aiConversations.createSessionStore({ conversationId: chat.id, turnId: turn.id });
      await store.append({
        role: "assistant",
        content: [pending.callId, "other-call"].map((callId) => ({ type: "tool_call", id: callId, name: "mail.draft.send", args: {} })),
      });
      if (table === "ai.task_messages") {
        await sql`WITH moved AS (
        DELETE FROM ai.messages WHERE conversation_id=${chat.id}::uuid AND loop_id=${turn.id}::text AND role='assistant' RETURNING *
      ) INSERT INTO ai.task_messages SELECT * FROM moved`;
      }
      const target = { conversationId: chat.id, turnId: turn.id };
      const storedReview = { ...review, ask: "sensitive" as const };
      await recordAiToolReview({ ...target, callId: pending.callId, review: storedReview });
      await recordAiToolReview({ ...target, callId: "other-call", review: { ...review, ask: "deletes" } });
      const row = (await listPending(query)).items[0]!;
      expect(row.storedReview).toEqual(storedReview);
      expect(row.details).toEqual(review);
      expect(row.argsDigest).toBe(before.argsDigest);
      expect(presentPendingApproval(row, [], { ask: "sends" }).review).toEqual(storedReview);
      expect(presentPendingApproval(row, []).review).toEqual(storedReview);
    },
  );

  test("a capability's own approval reads the review stored under its parent call", async () => {
    const { userId, chat, turn, ask } = await fixture();
    const review = reviewFixture();
    const id = await ask({ review });
    // Capability approvals wait as "<call>-approval-<n>"; the review belongs to the call itself.
    await sql`UPDATE ai.pending_actions SET kind='custom_approval', call_id='write-1-approval-0' WHERE approval_id=${id}::uuid`;
    const store = aiConversations.createSessionStore({ conversationId: chat.id, turnId: turn.id });
    await store.append({ role: "assistant", content: [{ type: "tool_call", id: "write-1", name: "mail.draft.send", args: {} }] });
    const storedReview = { ...review, ask: "sensitive" as const };
    await recordAiToolReview({ conversationId: chat.id, turnId: turn.id, callId: "write-1", review: storedReview });
    const row = (await listPending({ approverUserId: userId, id })).items[0]!;
    expect(row.storedReview).toEqual(storedReview);
    expect(presentPendingApproval(row, [], { ask: "sends" }).review).toEqual(storedReview);
  });
});
