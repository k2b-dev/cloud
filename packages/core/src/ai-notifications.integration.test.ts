import { beforeAll, expect, test } from "bun:test";
import { aiChatTasks, aiConversations, createAiShortId, migrateCloudAi } from "@k2b/cloud/ai";
import { APPROVALS_PAGE_PATH } from "@k2b/cloud/contracts/approvals";
import { approvals, migrateApprovals } from "@k2b/cloud/services/approvals";
import { registerNotificationDefinitions } from "@k2b/cloud/services/notifications/catalog";
import { sql } from "bun";
import { databaseSuite } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import { createAiNotificationService } from "./ai-notifications";
import { app } from "./config";

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = databaseSuite();

suite("Core AI completion notifications", () => {
  beforeAll(async () => {
    await migrateCloudAi();
    await migrateApprovals();
    await registerNotificationDefinitions(app.meta.id, app.notifications);
  });
  test("recovers each completed personal chat once and skips non-chat runs", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`assistant-notify-${suffix}`}, 'local', 'user', 'Assistant Notify', ${`assistant-notify-${suffix}@example.test`}, 'Assistant', 'Notify')
      RETURNING id
    `;
    const userId = user!.id;
    const conversationIds: string[] = [];
    const service = createAiNotificationService(app.notifications);

    try {
      const direct = await aiConversations.createConversation({ ownerUserId: userId });
      const resource = await aiConversations.createConversation({
        ownerUserId: userId,
        draft: [{ type: "resource", ref: { type: "grids.table", id: crypto.randomUUID() } }],
      });
      const compaction = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(direct.id, resource.id, compaction.id);

      const turns = await sql<{ id: string; conversation_id: string }[]>`
        INSERT INTO ai.turns (short_id, conversation_id, status, completed_at, run_config)
        VALUES
          (${createAiShortId()}, ${direct.id}::uuid, 'completed', now(), (${JSON.stringify({ kind: "chat" })}::text)::jsonb),
          (${createAiShortId()}, ${resource.id}::uuid, 'completed', now(), (${JSON.stringify({ kind: "chat" })}::text)::jsonb),
          (${createAiShortId()}, ${compaction.id}::uuid, 'completed', now(), (${JSON.stringify({ kind: "compact" })}::text)::jsonb)
        RETURNING id, conversation_id
      `;
      const directTurn = turns.find((turn) => turn.conversation_id === direct.id)!;
      const resourceTurn = turns.find((turn) => turn.conversation_id === resource.id)!;
      const compactionTurn = turns.find((turn) => turn.conversation_id === compaction.id)!;

      const [eligibility] = await sql<{ run_kind: string | null; after_definition: boolean }[]>`
        SELECT turn.run_config->>'kind' AS run_kind,
               turn.completed_at >= definition.first_seen_at AS after_definition
        FROM ai.turns turn
        JOIN ai.conversations conversation ON conversation.id = turn.conversation_id
        JOIN notifications.definitions definition ON definition.id = ${app.notifications.turnCompleted.id}
        WHERE turn.id = ${directTurn.id}::uuid
      `;
      expect(eligibility).toEqual({ run_kind: "chat", after_definition: true });

      const first = await service.notifyTurnCompleted(directTurn.id);
      // A running Assistant replica may win the same recovery race. The
      // durable event below is the invariant; both paths use the same key.
      expect(first.failed).toBe(0);
      expect(first.scanned).toBe(first.sent);
      expect(first.scanned).toBeLessThanOrEqual(1);
      expect(await service.notifyTurnCompleted(directTurn.id)).toEqual({ scanned: 0, sent: 0, failed: 0 });
      const resourceCompletion = await service.notifyTurnCompleted(resourceTurn.id);
      expect(resourceCompletion.failed).toBe(0);
      expect(resourceCompletion.scanned).toBe(resourceCompletion.sent);
      expect(resourceCompletion.scanned).toBeLessThanOrEqual(1);
      expect(await service.notifyTurnCompleted(compactionTurn.id)).toEqual({ scanned: 0, sent: 0, failed: 0 });

      const events = await sql<{ id: string; title: string; target_href: string | null; idempotency_key: string }[]>`
        SELECT id, title, target_href, idempotency_key
        FROM notifications.events
        WHERE definition_id = ${app.notifications.turnCompleted.id}
          AND recipient_user_id = ${userId}::uuid
      `;
      expect(events).toEqual(
        expect.arrayContaining([
          {
            id: expect.any(String),
            title: "Assistant response ready",
            target_href: `/app/assistant?conversation=${direct.shortId}`,
            idempotency_key: `turn:${directTurn.id}`,
          },
          {
            id: expect.any(String),
            title: "Assistant response ready",
            target_href: `/app/assistant?conversation=${resource.shortId}`,
            idempotency_key: `turn:${resourceTurn.id}`,
          },
        ]),
      );
      expect(events).toHaveLength(2);
      const deliveries = await sql<{ channel: string; status: string; error_code: string | null; payload_encrypted: string | null }[]>`
        SELECT delivery.channel, delivery.status, delivery.error_code, delivery.payload_encrypted
        FROM notifications.deliveries delivery
        JOIN notifications.events event ON event.id = delivery.event_id
        WHERE event.definition_id = ${app.notifications.turnCompleted.id}
          AND event.recipient_user_id = ${userId}::uuid
      `;
      expect(deliveries).toHaveLength(2);
      for (const delivery of deliveries) {
        expect(delivery).toEqual(expect.objectContaining({ channel: "browser", status: "suppressed", error_code: "no_endpoint" }));
        expect(delivery.payload_encrypted).toBeNull();
      }
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("approval notifications bundle new external requests at most every 15 minutes", async () => {
    const uid = `approval-notify-${crypto.randomUUID()}`;
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,mail)
      VALUES(${uid},'local','user',${`${uid}@example.test`}) RETURNING id`;
    if (!user) throw new Error("Missing fixture user");
    const userId = user.id;
    const service = createAiNotificationService(app.notifications);
    const ask = async (signedInSession = false, linked = true) => {
      const chat = await aiConversations.createConversation({ ownerUserId: userId });
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelProfileId: "mock",
        runConfig: { kind: "chat", input: "Send", ...(signedInSession ? { signedInSession: true } : {}) },
        userMessage: { role: "user", content: [{ type: "text", text: "Send" }] },
      });
      const request = await approvals.request({
        appId: "mail",
        action: "draft.send",
        requester: { kind: "assistant_turn", appId: "assistant", ref: `${turn.id}/send` },
        subjectId: userId,
        approverUserId: userId,
        assurance: "confirm",
        sentence: "Mail: Send draft",
        input: {},
        expiresInMs: 600_000,
      });
      if (!request.ok) throw new Error("Missing approval");
      if (linked)
        await aiConversations.savePendingTurnAction({
          approvalId: request.id,
          conversationId: chat.id,
          turnId: turn.id,
          callId: "send",
          kind: "approval",
          status: "pending",
          name: "mail.draft.send",
          args: {},
          allowAlways: false,
          approvalScope: "draft",
          resolvedEvent: null,
        });
      return request.id;
    };
    const events = async () => [
      ...(await sql<{ title: string; target_href: string; idempotency_key: string }[]>`
      SELECT title,target_href,idempotency_key FROM notifications.events
      WHERE definition_id=${app.notifications.approvalWaiting.id} AND recipient_user_id=${userId}::uuid ORDER BY created_at,id`),
    ];
    try {
      const browser = await ask(true);
      expect(await service.notifyApprovalWaiting(browser)).toEqual({ scanned: 0, sent: 0, failed: 0 });
      const unlinked = await ask(false, false);
      expect(await service.notifyApprovalWaiting(unlinked)).toEqual({ scanned: 0, sent: 0, failed: 0 });
      const expired = await ask();
      await sql`UPDATE approvals.requests SET expires_at=now()-interval '1 second' WHERE id=${expired}::uuid`;
      expect(await service.notifyApprovalWaiting(expired)).toEqual({ scanned: 0, sent: 0, failed: 0 });
      const old = await ask();
      await sql`UPDATE approvals.requests SET created_at=(SELECT first_seen_at-interval '1 second' FROM notifications.definitions WHERE id=${app.notifications.approvalWaiting.id}) WHERE id=${old}::uuid`;
      expect(await service.notifyApprovalWaiting(old)).toEqual({ scanned: 0, sent: 0, failed: 0 });
      await approvals.cancel([old]);
      const stale = await ask();
      await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${userId}::uuid`;
      expect(await service.notifyApprovalWaiting(stale)).toEqual({ scanned: 0, sent: 0, failed: 0 });
      const first = await ask();
      expect((await service.notifyApprovalWaiting(first)).failed).toBe(0);
      expect(await service.notifyApprovalWaiting(first)).toEqual({ scanned: 0, sent: 0, failed: 0 });
      const second = await ask();
      expect(await service.notifyApprovalWaiting(second)).toEqual({ scanned: 0, sent: 0, failed: 0 });
      expect(await events()).toMatchObject([
        { title: "Approval waiting", target_href: APPROVALS_PAGE_PATH, idempotency_key: `approval:${first}` },
      ]);
      const ageNotices = () => sql`UPDATE notifications.events SET created_at=created_at-interval '16 minutes'
        WHERE definition_id=${app.notifications.approvalWaiting.id} AND recipient_user_id=${userId}::uuid`;
      await ageNotices();
      expect((await service.notifyApprovalWaiting(second)).failed).toBe(0);
      expect(await events()).toMatchObject([
        { idempotency_key: `approval:${first}` },
        { title: "2 approvals waiting", idempotency_key: `approval:${second}` },
      ]);
      expect(await service.notifyApprovalWaiting(second)).toEqual({ scanned: 0, sent: 0, failed: 0 });
      await ageNotices();
      expect(await service.notifyApprovalWaiting(second)).toEqual({ scanned: 0, sent: 0, failed: 0 });
      expect(await events()).toHaveLength(2);
      const third = await ask();
      await approvals.decide(first, { approved: false }, { userId, via: "web_session" });
      await ageNotices();
      expect(await service.notifyApprovalWaiting(third)).toEqual({ scanned: 0, sent: 0, failed: 0 });
      expect(await events()).toHaveLength(2);
      const fourth = await ask();
      await ageNotices();
      // An older request's trigger still checks the newest request for this person.
      expect((await service.notifyApprovalWaiting(second)).failed).toBe(0);
      expect(await events()).toMatchObject([
        { idempotency_key: `approval:${first}` },
        { idempotency_key: `approval:${second}` },
        { title: "3 approvals waiting", target_href: APPROVALS_PAGE_PATH, idempotency_key: `approval:${fourth}` },
      ]);
    } finally {
      await sql`DELETE FROM audit.events WHERE actor_user_id=${userId}::uuid AND target_type='approval_request'`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test("notifies once when a scheduled task needs attention", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`assistant-task-notify-${suffix}`}, 'local', 'user', 'Assistant Task Notify', ${`assistant-task-notify-${suffix}@example.test`}, 'Assistant', 'Notify')
      RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id });
    const service = createAiNotificationService(app.notifications);

    try {
      const runAt = new Date(Date.now() + 60_000).toISOString();
      const task = await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Check the release.",
        schedule: { kind: "once", runAt },
        timezone: "Europe/Berlin",
      });
      const occurrence = await aiChatTasks.createOccurrence({
        taskId: task!.id,
        scheduledFor: runAt,
        trigger: "scheduled",
        requestKey: `test:${suffix}`,
      });
      await aiChatTasks.failOccurrence({ occurrenceId: occurrence!.id, error: "Model profile unavailable" });

      const first = await service.notifyTaskNeedsAttention(occurrence!.id);
      expect(first.failed).toBe(0);
      expect(first.scanned).toBe(first.sent);
      expect(first.scanned).toBeLessThanOrEqual(1);
      expect(await service.notifyTaskNeedsAttention(occurrence!.id)).toEqual({ scanned: 0, sent: 0, failed: 0 });

      const events = await sql<{ title: string; target_href: string | null; idempotency_key: string }[]>`
        SELECT title, target_href, idempotency_key
        FROM notifications.events
        WHERE definition_id = ${app.notifications.taskNeedsAttention.id}
          AND recipient_user_id = ${user!.id}::uuid
      `;
      expect(events).toEqual([
        {
          title: `Routine ${task!.shortId} needs attention`,
          target_href: `/app/assistant?conversation=${conversation.shortId}`,
          idempotency_key: `occurrence:${occurrence!.id}`,
        },
      ]);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });
});
