import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { migrateCloudAi } from "../../ai/migrate";
import { aiConversations } from "../../ai/store";
import { APPROVALS_PAGE_SIZE } from "../../contracts/approvals";
import { type ApprovalRequestInput, approvals, countPending, listPending, presentPendingApproval } from ".";

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
      modelProfileId: "mock",
      runConfig: { kind: "chat", input: "Write" },
      userMessage: { role: "user", content: [{ type: "text", text: "Write" }] },
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
});
