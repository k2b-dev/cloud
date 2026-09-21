import { beforeAll, expect, test } from "bun:test";
import { aiChatTasks, aiConversations, createAiShortId, migrateCloudAi } from "@k2b/cloud/ai";
import { registerNotificationDefinitions } from "@k2b/cloud/services/notifications/catalog";
import { toPgUuidArray } from "@k2b/cloud/services/postgres";
import { sql } from "bun";
import { databaseSuite, suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import { createAiNotificationService } from "./ai-notifications";
import { app } from "./config";

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = databaseSuite();

suite("Core AI completion notifications", () => {
  beforeAll(async () => {
    await migrateCloudAi();
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

const costSuite = suiteFor("database", "valkey");

costSuite("background cost alert recovery", () => {
  beforeAll(async () => {
    await migrateCloudAi();
    await registerNotificationDefinitions(app.meta.id, app.notifications);
  });
  // Recovery scans the whole database: on the shared integration database the two
  // alerts also fan out to foreign admins and foreign candidates are sent alongside.
  // Every injection and assertion is therefore scoped to the users this test creates.
  test("sends only to current local and IPA admins; partial delivery retries do not duplicate events", async () => {
    const { spyOn } = await import("bun:test");
    const cloud = await import("@k2b/cloud");
    const deliveryRuntime = await import("@k2b/cloud/services/notifications/runtime");
    const platform = await import("@k2b/cloud/services/notifications/platform");
    const enqueue = spyOn(deliveryRuntime, "enqueueNotificationDeliveries").mockResolvedValue();
    const enqueueOne = spyOn(deliveryRuntime, "enqueueNotificationDelivery").mockResolvedValue();
    const { getFreeIpaConfig } = await import("@k2b/cloud/services");
    let recover: ((context: { runId: string }) => Promise<void>) | undefined;
    const scheduler = {
      create: async (input: { process: (context: { runId: string }) => Promise<void> }) => {
        recover = input.process;
      },
      process: async () => ({ stop: () => {}, drain: async () => {} }),
    };
    // Keep the existing recovery callback and real notification persistence, only isolate its scheduler transport.
    const lazy = spyOn(cloud, "lazySync").mockReturnValue(() => scheduler);
    const service = createAiNotificationService(app.notifications);
    const prefix = `cost-notification-${crypto.randomUUID()}`;
    const alerts = [crypto.randomUUID(), crypto.randomUUID()];
    const ownKeys = new Set<string>();
    const users = await sql<{ id: string; uid: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name,admin)
      VALUES(${`${prefix}-local-admin`},'local','user','Cost local admin',true),
        (${`${prefix}-local-user`},'local','user','Cost local user',false),
        (${`${prefix}-ipa-admin`},'ipa','user','Cost IPA admin',false),
        (${`${prefix}-ipa-not-admin`},'ipa','user','Cost IPA member',false)
      RETURNING id,uid`;
    const userIds = toPgUuidArray(users.map((user) => user.id));
    const localAdmin = users.find((user) => user.uid.endsWith("-local-admin"))!;
    const ipaAdmin = users.find((user) => user.uid.endsWith("-ipa-admin"))!;
    const adminGroup = (await getFreeIpaConfig()).groupsAdmin[0]!;
    await sql`INSERT INTO auth.ipa_user_effective_groups(user_id,group_name) VALUES(${ipaAdmin.id}::uuid,${adminGroup})`;
    await sql`INSERT INTO ai.cost_alerts(id,kind,cost,unit) VALUES(${alerts[0]!}::uuid,'warning',2.5,'EUR'),(${alerts[1]!}::uuid,'stop',5,'EUR')`;
    for (const alert of alerts) for (const admin of [localAdmin, ipaAdmin]) ownKeys.add(`cost:${alert}:${admin.id}`);
    let sendFailure: ReturnType<typeof spyOn<typeof platform, "sendTypedNotification">> | undefined;
    try {
      await service.start();
      if (!recover) throw new Error("Recovery scheduler callback was not registered.");
      const send = platform.sendTypedNotification;
      let injected = false;
      sendFailure = spyOn(platform, "sendTypedNotification").mockImplementation((definition, input) => {
        if (injected || !ownKeys.has(input.idempotencyKey)) return send(definition, input);
        injected = true;
        return Promise.reject(new Error("Injected recoverable notification failure"));
      });
      await expect(recover({ runId: crypto.randomUUID() })).rejects.toThrow("Injected recoverable notification failure");
      sendFailure.mockRestore();
      sendFailure = undefined;
      await recover({ runId: crypto.randomUUID() });
      await recover({ runId: crypto.randomUUID() });
      const events = await sql<{ recipient_user_id: string; idempotency_key: string; title: string; target_href: string }[]>`
        SELECT recipient_user_id,idempotency_key,title,target_href FROM notifications.events
        WHERE definition_id=${app.notifications.backgroundCosts.id}
          AND recipient_user_id=ANY(${userIds}::uuid[])
          AND (idempotency_key LIKE ${`cost:${alerts[0]}:%`} OR idempotency_key LIKE ${`cost:${alerts[1]}:%`})`;
      expect(events).toHaveLength(4);
      expect(events.map((event) => event.recipient_user_id).sort()).toEqual(
        [localAdmin.id, localAdmin.id, ipaAdmin.id, ipaAdmin.id].sort(),
      );
      expect(new Set(events.map((event) => event.idempotency_key)).size).toBe(4);
      expect(events.every((event) => event.target_href === "/admin/settings?tab=ai-quotas&view=rules")).toBe(true);
      expect(events.map((event) => event.title).sort()).toEqual(
        ["Background AI cost warning", "Background AI cost warning", "Background AI stopped", "Background AI stopped"].sort(),
      );
      const deliveries = await sql<{ channel: string; status: string; error_code: string | null }[]>`
        SELECT d.channel,d.status,d.error_code FROM notifications.deliveries d
        JOIN notifications.events e ON e.id=d.event_id WHERE e.definition_id=${app.notifications.backgroundCosts.id}
          AND e.recipient_user_id=ANY(${userIds}::uuid[])
          AND (e.idempotency_key LIKE ${`cost:${alerts[0]}:%`} OR e.idempotency_key LIKE ${`cost:${alerts[1]}:%`})`;
      expect(deliveries).toHaveLength(4);
      expect(
        deliveries.every(
          (delivery) => delivery.channel === "browser" && delivery.status === "suppressed" && delivery.error_code === "no_endpoint",
        ),
      ).toBe(true);
    } finally {
      sendFailure?.mockRestore();
      await service.stop();
      lazy.mockRestore();
      enqueue.mockRestore();
      enqueueOne.mockRestore();
      for (const user of users) await sql`DELETE FROM auth.users WHERE id=${user.id}::uuid`;
      for (const id of alerts) await sql`DELETE FROM ai.cost_alerts WHERE id=${id}::uuid`;
    }
  });
});
