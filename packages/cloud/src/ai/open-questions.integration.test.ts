import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { reviewFixture } from "../_internal/capability-review.test-fixture";
import { APPROVALS_PAGE_SIZE } from "../contracts/approvals";
import { approvals } from "../services/approvals";
import { AiInvalidationSchema } from "./live-events";
import { migrateCloudAi } from "./migrate";
import { listAiOpenQuestions } from "./open-questions";
import type { AiTurnBlock } from "./protocol";
import { aiConversations } from "./store";

const now = "2026-10-17T12:00:00.000Z";
type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
const tool = (callId: string, extra: Partial<ToolBlock> = {}): ToolBlock => ({
  kind: "tool",
  id: `tool-${callId}`,
  callId,
  name: "mail.draft.send",
  status: "awaiting_approval",
  presentation: {
    kind: "capability",
    capabilityKind: "action",
    appId: "mail",
    appName: "Mail",
    appIcon: "ti ti-mail",
    appAccent: "blue",
    title: "Send draft",
  },
  ...extra,
});

databaseSuite()("open questions", () => {
  const users: string[] = [];
  let sequence = 0;
  beforeAll(async () => {
    setSystemTime(new Date(now));
    await migrateCloudAi();
  });
  afterAll(async () => {
    try {
      for (const userId of users) {
        await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
        await sql`DELETE FROM events.outbox WHERE kind='live' AND app_id='core' AND ordering_key=${`u:${userId}`}`;
      }
    } finally {
      setSystemTime();
    }
  });
  const fixture = async () => {
    const uid = `open-questions-${crypto.randomUUID()}`;
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,mail)
      VALUES(${uid},'local','user',${`${uid}@example.test`}) RETURNING id`;
    if (!user) throw new Error("Missing fixture user");
    const userId = user.id;
    users.push(userId);
    const chat = await aiConversations.createConversation({ ownerUserId: userId, title: "Write a letter" });
    const { turn } = await aiConversations.submitChatTurn({
      conversationId: chat.id,
      modelProfileId: "mock",
      runConfig: { kind: "chat", input: "Write a letter" },
      userMessage: { role: "user", content: [{ type: "text", text: "Write a letter" }] },
    });
    const ask = async (
      options: { approverUserId?: string; callId?: string; kind?: "approval" | "custom_approval"; block?: unknown; linked?: boolean } = {},
    ) => {
      const order = sequence++;
      const callId = options.callId ?? `send-${order}`;
      const request = await approvals.request({
        appId: "mail",
        action: "draft.send",
        requester: { kind: "assistant_turn", appId: "assistant", ref: `${turn.id}/${callId}` },
        subjectId: userId,
        approverUserId: options.approverUserId ?? userId,
        assurance: "standard",
        sentence: "Send this draft\nFull request details",
        input: {},
        expiresInMs: 600_000,
      });
      if (!request.ok) throw new Error("Missing approval");
      // PostgreSQL owns expiry. Infinite bounds keep these fixtures independent of the server's calendar.
      await sql`UPDATE approvals.requests SET created_at=${now}::timestamptz + (${order} * interval '1 second'),
        expires_at='infinity'::timestamptz WHERE id=${request.id}::uuid`;
      if (options.linked !== false)
        await aiConversations.savePendingTurnAction({
          approvalId: request.id,
          conversationId: chat.id,
          turnId: turn.id,
          callId,
          kind: options.kind ?? "approval",
          status: "pending",
          name: "mail.draft.send",
          args: {},
          allowAlways: false,
          approvalScope: "draft",
          resolvedEvent: null,
        });
      if (options.block !== undefined)
        // As the store writes them: a text parameter cast to jsonb, since a bare jsonb parameter would store one JSON string.
        await sql`UPDATE ai.turns SET live_blocks=COALESCE(live_blocks, '[]'::jsonb) || (${JSON.stringify([options.block])}::text)::jsonb
          WHERE id=${turn.id}::uuid`;
      return { id: request.id, callId };
    };
    const read = () => listAiOpenQuestions({ ownerUserId: userId, locale: "en", timeZone: "Europe/Berlin" });
    return { userId, chat, turn, ask, read };
  };

  test("shares approval eligibility and never exposes another person's chat", async () => {
    const owner = await fixture();
    const other = await fixture();
    const open = await owner.ask();
    await other.ask();
    await other.ask({ approverUserId: owner.userId });
    await owner.ask({ approverUserId: other.userId });
    await owner.ask({ linked: false });
    const decided = await owner.ask();
    expect(await approvals.decide(decided.id, { approved: true }, { userId: owner.userId, via: "web_session" })).toMatchObject({
      ok: true,
    });
    const expired = await owner.ask();
    await sql`UPDATE approvals.requests SET expires_at='-infinity'::timestamptz WHERE id=${expired.id}::uuid`;
    const cancelled = await owner.ask();
    await approvals.cancel([cancelled.id]);
    const resolved = await owner.ask();
    await aiConversations.resolvePendingTurnAction({
      conversationId: owner.chat.id,
      turnId: owner.turn.id,
      callId: resolved.callId,
      event: { type: "approval_response", callId: resolved.callId, approved: false },
    });
    expect(await owner.read()).toMatchObject({ items: [{ id: open.id, conversationId: owner.chat.shortId }], count: 1 });
    await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${owner.userId}::uuid`;
    expect(await owner.read()).toEqual({ items: [], count: 0 });
  });

  test("bounds the newest-first page while counting all questions, including timestamp ties", async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (let i = 0; i < APPROVALS_PAGE_SIZE + 1; i++) ids.push((await f.ask()).id);
    const page = await f.read();
    expect(page.items.map((item) => item.id)).toEqual(ids.slice(1).reverse());
    expect(page.count).toBe(21);
    expect(page.items[0]?.createdAt).toMatch(/^2026-10-17T12:/);
    await sql`UPDATE approvals.requests SET created_at=${now}::timestamptz WHERE approver_user_id=${f.userId}::uuid`;
    expect((await f.read()).items.map((item) => item.id)).toEqual([...ids].sort().reverse().slice(0, APPROVALS_PAGE_SIZE));
  });

  test("uses the chat's tool block and card anchor for standard and custom approvals, the card's words and app, and the current chat title", async () => {
    const f = await fixture();
    const review = reviewFixture();
    const short = await f.ask({
      callId: "short",
      block: tool("short", {
        review: { ...review, sentence: { ...review.sentence, short: "Send Meeting.pdf" } },
      }),
    });
    const action = await f.ask({ callId: "action", block: tool("action", { review: { ...review, preview: undefined } }) });
    const custom = await f.ask({
      callId: "parent-approval-1",
      kind: "custom_approval",
      block: tool("parent-approval-1", { id: "tool-parent", review }),
    });
    // A stored block may still carry the approval's own id; the chat renders the card under the parent call.
    const stored = await f.ask({
      callId: "stored-approval-0",
      kind: "custom_approval",
      block: tool("stored-approval-0", { id: "tool-stored-approval-0", review }),
    });
    const legacy = await f.ask({
      callId: "legacy",
      block: tool("legacy", { review: { legacy: { question: "Send the letter exactly as written?", rows: [] } } }),
    });
    const approvalReview = await f.ask({
      callId: "approval-review",
      block: tool("approval-review", { approval: { allowAlways: false, review: { message: "Send from the saved approval?" } } }),
    });
    const withoutReview = await f.ask({ callId: "no-review", block: tool("no-review") });
    // A parent-call block is not the custom question block: the callId must match the pending row.
    const missing = await f.ask({ callId: "missing-approval-1", kind: "custom_approval", block: tool("missing", { review }) });
    const items = (await f.read()).items;
    expect(items.find((item) => item.id === short.id)).toMatchObject({
      anchor: "tool-short",
      short: "Send Meeting.pdf",
      app: { name: "Mail", icon: "ti ti-mail", accent: "blue" },
    });
    expect(items.find((item) => item.id === action.id)?.short).toBe("Send Meeting.pdf to Lea");
    expect(items.find((item) => item.id === custom.id)).toMatchObject({ anchor: "tool-parent", short: "Send Meeting.pdf to Lea" });
    expect(items.find((item) => item.id === stored.id)).toMatchObject({ anchor: "tool-stored", short: "Send Meeting.pdf to Lea" });
    expect(items.find((item) => item.id === legacy.id)?.short).toBe("Send the letter exactly as written?");
    expect(items.find((item) => item.id === approvalReview.id)?.short).toBe("Send from the saved approval?");
    expect(items.find((item) => item.id === withoutReview.id)?.short).toBe("Send draft?");
    expect(items.find((item) => item.id === missing.id)).toMatchObject({ anchor: "tool-missing", short: "Send this draft" });
    await sql`UPDATE ai.conversations SET title='A renamed letter' WHERE id=${f.chat.id}::uuid`;
    expect((await f.read()).items.every((item) => item.conversationTitle === "A renamed letter")).toBe(true);
  });

  test("isolates malformed blocks and reviews without losing other questions", async () => {
    const f = await fixture();
    const valid = await f.ask({ callId: "valid", block: tool("valid", { review: reviewFixture() }) });
    const badReview = await f.ask({ callId: "bad-review", block: { ...tool("bad-review"), review: { sentence: null } } });
    const badBlock = await f.ask({ callId: "bad-block", block: { kind: "tool", callId: "bad-block" } });
    const incompleteReview = await f.ask({
      callId: "incomplete-review",
      block: { ...tool("incomplete-review"), review: { locale: "en", sentence: { action: "Incomplete sentence" }, slots: {} } },
    });
    const falseReview = await f.ask({ callId: "false-review", block: { ...tool("false-review"), review: false } });
    const warnings = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await f.read()).toMatchObject({
        count: 5,
        items: [
          { id: falseReview.id, anchor: "tool-false-review", short: "Send this draft" },
          { id: incompleteReview.id, anchor: "tool-incomplete-review", short: "Send this draft" },
          { id: badBlock.id, anchor: "tool-bad-block", short: "Send this draft" },
          {
            id: badReview.id,
            anchor: "tool-bad-review",
            short: "Send this draft",
            app: { name: "Mail", icon: "ti ti-mail", accent: "blue" },
          },
          { id: valid.id, short: "Send Meeting.pdf to Lea" },
        ],
      });
      expect(
        warnings.mock.calls.filter(
          ([source, message]) => source === "[ai:open-questions]" && message === "Failed to present open question",
        ),
      ).toHaveLength(4);
    } finally {
      warnings.mockRestore();
    }
    await sql`UPDATE ai.turns SET live_blocks='{}'::jsonb WHERE id=${f.turn.id}::uuid`;
    expect((await f.read()).items.every((item) => item.short === "Send this draft")).toBe(true);
  });

  test("deciding the first of two questions invalidates the owner's sidebar while its turn keeps waiting", async () => {
    const f = await fixture();
    const first = await f.ask({ callId: "first", block: tool("first") });
    await f.ask({ callId: "second", block: tool("second") });
    await sql`UPDATE ai.turns SET status='waiting_for_action' WHERE id=${f.turn.id}::uuid`;
    await sql`DELETE FROM events.outbox WHERE kind='live' AND app_id='core' AND ordering_key=${`u:${f.userId}`}`;
    expect(await approvals.decide(first.id, { approved: false }, { userId: f.userId, via: "web_session" })).toMatchObject({ ok: true });
    await aiConversations.resolvePendingTurnAction({
      conversationId: f.chat.id,
      turnId: f.turn.id,
      callId: first.callId,
      event: { type: "approval_response", callId: first.callId, approved: false },
    });
    const events = await sql<{ payload: { d: unknown } }[]>`SELECT payload FROM events.outbox
      WHERE kind='live' AND app_id='core' AND ordering_key=${`u:${f.userId}`} ORDER BY seq`;
    expect(events.map((event) => AiInvalidationSchema.parse(event.payload.d))).toMatchObject([
      { conversationId: f.chat.shortId, domains: ["conversation-list"] },
    ]);
    const [turn] = await sql<{ status: string }[]>`SELECT status FROM ai.turns WHERE id=${f.turn.id}::uuid`;
    expect(turn?.status).toBe("waiting_for_action");
    expect((await f.read()).count).toBe(1);
  });

  test("a browser tool call sends no update of the list of open questions", async () => {
    const f = await fixture();
    await sql`DELETE FROM events.outbox WHERE kind='live' AND app_id='core' AND ordering_key=${`u:${f.userId}`}`;
    await aiConversations.savePendingTurnAction({
      conversationId: f.chat.id,
      turnId: f.turn.id,
      callId: "browser-read",
      kind: "client_tool",
      status: "pending",
      name: "browser.read",
      args: {},
      allowAlways: false,
      approvalScope: "browser",
      resolvedEvent: null,
    });
    await sql`UPDATE ai.pending_actions SET status='resolved' WHERE turn_id=${f.turn.id}::uuid AND call_id='browser-read'`;
    await sql`DELETE FROM ai.pending_actions WHERE turn_id=${f.turn.id}::uuid AND call_id='browser-read'`;
    const [events] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM events.outbox
      WHERE kind='live' AND app_id='core' AND ordering_key=${`u:${f.userId}`}`;
    expect(events?.count).toBe(0);
  });
});
