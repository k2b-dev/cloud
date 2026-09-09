import { describe, expect, test } from "bun:test";
import { aiChatTasks, aiConversations, createAiShortId, migrateCloudAi } from "@k2b/cloud/ai";
import { registerNotificationDefinitions } from "@k2b/cloud/services/notifications/catalog";
import { sql } from "bun";
import { app } from "./config";
import { createAiNotificationService } from "./ai-notifications";

const canRun = async (): Promise<boolean> => {
  if (!process.env.APP_SECRET) return false;
  try {
    const [row] = await sql<{ users: string | null; definitions: string | null }[]>`
      SELECT to_regclass('auth.users')::text AS users,
             to_regclass('notifications.definitions')::text AS definitions
    `;
    if (!row?.users || !row.definitions) return false;
    await migrateCloudAi();
    await registerNotificationDefinitions(app.meta.id, app.notifications);
    return true;
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = (await canRun()) ? describe : describe.skip;

suite("Core AI completion notifications", () => {
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
      expect(events).toEqual(expect.arrayContaining([
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
      ]));
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
          title: `Scheduled task ${task!.shortId} needs attention`,
          target_href: `/app/assistant?conversation=${conversation.shortId}`,
          idempotency_key: `occurrence:${occurrence!.id}`,
        },
      ]);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });
});
