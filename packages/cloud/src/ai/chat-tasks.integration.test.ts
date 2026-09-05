import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { mandates } from "../services/mandates";
import { AiChatTaskIdempotencyConflictError, aiChatTasks } from "./chat-tasks";
import { migrateCloudAi } from "./migrate";
import { AI_SHORT_ID_PATTERN, createAiShortId } from "./short-id";
import { aiConversations } from "./store";

const canUseAiDatabase = async (): Promise<boolean> => {
  try {
    const [row] = await sql<{ users: string | null }[]>`SELECT to_regclass('auth.users')::text AS users`;
    if (!row?.users) return false;
    await migrateCloudAi();
    return true;
  } catch {
    return false;
  }
};

const suite = (await canUseAiDatabase()) ? describe : describe.skip;

suite("AI chat tasks", () => {
  test("uses current mandate revisions for explicit lifecycle changes without restoring changed authority", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`ai-lifecycle-${suffix}`}, 'local', 'user', 'Lifecycle', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Current lifecycle authority" });
    try {
      const task = (await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Lifecycle",
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      }))!;
      const paused = await mandates.pause({
        mandateId: task.mandateId!,
        expectedRevision: task.mandateRevision!,
        authority: { kind: "workload", ownerAppId: "core" },
      });
      expect(paused.ok).toBe(true);
      // Explicit resume must work before scheduler reconciliation sees the independent pause.
      const resumed = await aiChatTasks.setState({ userId: user!.id, taskId: task.shortId, state: "active" });
      expect(resumed?.state).toBe("active");
      expect(resumed?.mandateRevision).toBe(task.mandateRevision! + 2);
      const narrowed = await mandates.updatePolicy({
        mandateId: task.mandateId!,
        expectedRevision: resumed!.mandateRevision!,
        authority: { kind: "workload", ownerAppId: "core" },
        policy: { version: 1, apps: ["mail"], operations: ["capability.query:mail.read"], actions: "deny" },
      });
      expect(narrowed.ok).toBe(true);
      await expect(aiChatTasks.setState({ userId: user!.id, taskId: task.shortId, state: "active" })).rejects.toThrow(
        "Scheduled task mandate cannot be resumed",
      );
      expect((await aiChatTasks.setState({ userId: user!.id, taskId: task.shortId, state: "paused" }))?.state).toBe("paused");
      const current = (await mandates.get(task.mandateId!))!;
      const changed = await mandates.updatePolicy({
        mandateId: current.id,
        expectedRevision: current.revision,
        authority: { kind: "workload", ownerAppId: "core" },
        policy: { version: 1, apps: [], operations: [], actions: "deny" },
      });
      expect(changed.ok).toBe(true);
      // Deletion must revoke the current binding even while the paused task retains an older revision.
      expect(await aiChatTasks.delete({ userId: user!.id, taskId: task.shortId })).toBe(true);
      expect((await mandates.get(current.id))?.state).toBe("revoked");

      const revokedTask = (await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Revoked",
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      }))!;
      expect(
        (
          await mandates.revoke({
            mandateId: revokedTask.mandateId!,
            expectedRevision: revokedTask.mandateRevision!,
            authority: { kind: "interactive", userId: user!.id },
            reason: "Owner revoked authority",
          })
        ).ok,
      ).toBe(true);
      await expect(aiChatTasks.setState({ userId: user!.id, taskId: revokedTask.shortId, state: "active" })).rejects.toThrow(
        "Mandate is revoked",
      );
      expect(await aiChatTasks.delete({ userId: user!.id, taskId: revokedTask.shortId })).toBe(true);
      expect((await mandates.get(revokedTask.mandateId!))?.state).toBe("revoked");
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("executes mandated queued occurrences without an issuance switch", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`ai-issuance-${suffix}`}, 'local', 'user', 'Issuance', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Issuance gate" });
    try {
      const task = (await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Migrated task",
        schedule: { kind: "once", runAt: new Date(Date.now() + 60_000).toISOString() },
        timezone: "UTC",
      }))!;
      await sql`UPDATE ai.chat_tasks SET run_at = now() - interval '1 minute' WHERE id = ${task.id}::uuid`;
      const waiting = (await aiChatTasks.get({ userId: user!.id, taskId: task.shortId }))!;
      expect(waiting.state).toBe("active");
      const [occurrence] = await aiChatTasks.materializeDueOnce();
      expect(occurrence?.state).toBe("queued");
      expect(await aiChatTasks.get({ userId: user!.id, taskId: task.shortId })).toEqual(waiting);
      expect((await aiChatTasks.materializeDueOnce())[0]?.id).toBe(occurrence!.id);
      expect((await aiChatTasks.listQueuedOccurrences())[0]?.occurrence.id).toBe(occurrence!.id);
      const deliver = () =>
        aiChatTasks.deliverOccurrence({
          occurrenceId: occurrence!.id,
          modelProfileId: "test",
          runConfig: { kind: "chat", input: waiting.prompt, toolSource: { kind: "none" } },
          userMessage: { role: "user", content: [{ type: "text", text: waiting.prompt }] },
          expectedRevision: waiting.revision,
        });
      expect(await aiChatTasks.get({ userId: user!.id, taskId: task.shortId })).toEqual(waiting);
      expect((await aiChatTasks.listOccurrences({ userId: user!.id, taskId: task.shortId }))?.[0]?.state).toBe("queued");
      expect(
        (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.turns WHERE conversation_id = ${conversation.id}::uuid`)[0]
          ?.count,
      ).toBe(0);

      expect((await aiChatTasks.listQueuedOccurrences())[0]?.occurrence.id).toBe(occurrence!.id);
      expect((await aiChatTasks.getQueuedOccurrence(occurrence!.id))?.task.id).toBe(task.id);
      const delivered = await deliver();
      if (!delivered.delivered) throw new Error("Expected migrated task to execute");
      await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status: "completed" });
      expect((await aiChatTasks.get({ userId: user!.id, taskId: task.shortId }))?.state).toBe("completed");
      const manualTask = (await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Manual run",
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      }))!;
      expect(
        (
          await aiChatTasks.createOccurrence({
            taskId: manualTask.id,
            scheduledFor: new Date().toISOString(),
            trigger: "manual",
            requestKey: `legacy-manual:${suffix}`,
          })
        )?.state,
      ).toBe("queued");
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("serializes concurrent task admission per chat and records only the task's current mandate", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`ai-concurrent-${suffix}`}, 'local', 'user', 'Concurrent', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Concurrent admission" });
    try {
      const tasks = await Promise.all(
        ["First", "Second"].map((prompt) =>
          aiChatTasks.create({
            userId: user!.id,
            chatId: conversation.shortId,
            prompt,
            schedule: { kind: "cron", cron: "0 9 * * *" },
            timezone: "UTC",
          }),
        ),
      );
      const results = await Promise.all(
        tasks.map(async (task) => {
          const occurrence = (await aiChatTasks.createOccurrence({
            taskId: task!.id,
            scheduledFor: new Date().toISOString(),
            trigger: "manual",
            requestKey: `${suffix}:${task!.id}`,
          }))!;
          const result = await aiChatTasks.deliverOccurrence({
            occurrenceId: occurrence.id,
            modelProfileId: "test",
            runConfig: {
              kind: "chat",
              input: task!.prompt,
              toolSource: { kind: "none" },
              mandate: { id: crypto.randomUUID(), revision: 999 },
            },
            userMessage: { role: "user", content: [{ type: "text", text: task!.prompt }] },
            expectedRevision: task!.revision,
          });
          if (result.delivered) {
            const [turn] = await sql<
              { mandate: unknown }[]
            >`SELECT run_config->'mandate' AS mandate FROM ai.turns WHERE id = ${result.turnId}::uuid`;
            expect(turn?.mandate).toEqual({ id: task!.mandateId, revision: task!.mandateRevision });
          }
          return result;
        }),
      );
      expect(results.filter((result) => result.delivered)).toHaveLength(1);
      expect(results.filter((result) => !result.delivered)).toEqual([{ delivered: false, reason: "busy" }]);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("converges live authority before admission and never resumes it through a prompt edit", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`ai-authority-${suffix}`}, 'local', 'user', 'Authority', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Authority checks" });
    try {
      for (const condition of ["paused", "revoked", "stale", "unconfirmed", "expired", "policy", "sponsor"] as const) {
        const task = (await aiChatTasks.create({
          userId: user!.id,
          chatId: conversation.shortId,
          prompt: condition,
          schedule: { kind: "cron", cron: "0 9 * * *" },
          timezone: "UTC",
        }))!;
        const occurrence = (await aiChatTasks.createOccurrence({
          taskId: task.id,
          scheduledFor: new Date().toISOString(),
          trigger: "manual",
          requestKey: `${suffix}:${condition}`,
        }))!;
        if (condition === "paused" || condition === "revoked") {
          await sql`UPDATE auth.mandates SET state = ${condition}, revision = revision + 1,
            revoked_at = CASE WHEN ${condition} = 'revoked' THEN now() ELSE NULL END,
            revoke_reason = CASE WHEN ${condition} = 'revoked' THEN 'Test revocation' ELSE NULL END WHERE id = ${task.mandateId}::uuid`;
        } else if (condition === "stale") {
          await sql`UPDATE auth.mandates SET revision = revision + 1 WHERE id = ${task.mandateId}::uuid`;
        } else if (condition === "unconfirmed") {
          await sql`UPDATE auth.mandates SET confirmed_at = NULL, confirmation_deadline = now() + interval '15 minutes' WHERE id = ${task.mandateId}::uuid`;
        } else if (condition === "expired") {
          await sql`UPDATE auth.mandates SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = ${task.mandateId}::uuid`;
        } else if (condition === "policy") {
          await sql`UPDATE auth.mandates SET policy = '{"version":1,"apps":["mail"],"operations":["capability.query:mail.read"],"actions":"deny"}'::jsonb WHERE id = ${task.mandateId}::uuid`;
        } else {
          await sql`UPDATE auth.users SET account_expires = now() - interval '1 hour' WHERE id = ${user!.id}::uuid`;
        }
        if (condition === "stale") {
          expect(
            await aiChatTasks.createOccurrence({
              taskId: task.id,
              scheduledFor: new Date().toISOString(),
              trigger: "manual",
              requestKey: `${suffix}:stale:admission`,
            }),
          ).toBeNull();
        } else if (condition === "expired") {
          expect(await aiChatTasks.getQueuedOccurrence(occurrence.id)).toBeNull();
        } else if (condition === "sponsor") {
          expect(await aiChatTasks.listActiveCron()).toEqual([]);
        }
        const delivery = await aiChatTasks.deliverOccurrence({
          occurrenceId: occurrence.id,
          modelProfileId: "test",
          runConfig: { kind: "chat", input: condition, toolSource: { kind: "none" } },
          userMessage: { role: "user", content: [{ type: "text", text: condition }] },
          expectedRevision: task.revision,
        });
        expect(delivery.delivered).toBe(false);
        expect(await aiChatTasks.getQueuedOccurrence(occurrence.id)).toBeNull();
        expect(
          await aiChatTasks.createOccurrence({
            taskId: task.id,
            scheduledFor: new Date().toISOString(),
            trigger: "manual",
            requestKey: `${suffix}:${condition}:second`,
          }),
        ).toBeNull();
        const stopped = await aiChatTasks.get({ userId: user!.id, taskId: task.shortId });
        expect(stopped?.state).toBe(condition === "paused" ? "paused" : "needs_attention");
        expect(
          (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.turns WHERE conversation_id = ${conversation.id}::uuid`)[0]
            ?.count,
        ).toBe(0);
        if (condition === "paused") {
          // Convergence must retain a revision usable only by an explicit interactive resume.
          expect(stopped?.mandateRevision).toBe(task.mandateRevision! + 1);
          expect((await aiChatTasks.setState({ userId: user!.id, taskId: task.shortId, state: "active" }))?.state).toBe("active");
          await sql`UPDATE auth.mandates SET state = 'paused', revision = revision + 1 WHERE id = ${task.mandateId}::uuid`;
          expect((await aiChatTasks.update({ userId: user!.id, taskId: task.shortId, prompt: "Edited safely" }))?.state).toBe("paused");
          expect((await mandates.get(task.mandateId!))?.state).toBe("paused");
        }
        await sql`UPDATE auth.users SET account_expires = NULL WHERE id = ${user!.id}::uuid`;
      }
      expect(await aiChatTasks.listActiveCron()).toEqual([]);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("finalizes terminal occurrences without creating or reviving execution authority", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`ai-terminal-${suffix}`}, 'local', 'user', 'Terminal', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Terminal checks" });
    try {
      for (const condition of ["legacy", "revoked", "stale", "narrowed", "malformed"] as const) {
        const runAt = new Date(Date.now() + 60_000).toISOString();
        const task = (await aiChatTasks.create({
          userId: user!.id,
          chatId: conversation.shortId,
          prompt: condition,
          schedule: { kind: "once", runAt },
          timezone: "UTC",
        }))!;
        const occurrence = (await aiChatTasks.createOccurrence({
          taskId: task.id,
          scheduledFor: runAt,
          trigger: "scheduled",
          requestKey: `${suffix}:${condition}`,
        }))!;
        const delivered = await aiChatTasks.deliverOccurrence({
          occurrenceId: occurrence.id,
          modelProfileId: "test",
          runConfig: { kind: "chat", input: condition, toolSource: { kind: "none" } },
          userMessage: { role: "user", content: [{ type: "text", text: condition }] },
          expectedRevision: task.revision,
        });
        if (!delivered.delivered) throw new Error("Expected initial authorized delivery");
        const status = condition === "revoked" || condition === "malformed" ? "failed" : "completed";
        await sql`UPDATE ai.turns SET status = ${status}, completed_at = now() WHERE id = ${delivered.turnId}::uuid`;
        if (condition === "legacy") {
          await sql`UPDATE ai.chat_tasks SET mandate_id = NULL, mandate_revision = NULL WHERE id = ${task.id}::uuid`;
          await sql`UPDATE auth.users SET account_expires = now() - interval '1 hour' WHERE id = ${user!.id}::uuid`;
        } else if (condition === "revoked") {
          await sql`UPDATE auth.mandates SET state = 'revoked', revoked_at = now(), revoke_reason = 'Test revocation', revision = revision + 1 WHERE id = ${task.mandateId}::uuid`;
        } else if (condition === "stale") {
          await sql`UPDATE auth.mandates SET revision = revision + 1 WHERE id = ${task.mandateId}::uuid`;
        } else if (condition === "narrowed") {
          await sql`UPDATE auth.mandates SET policy = '{"version":1,"apps":["mail"],"operations":["capability.query:mail.read"],"actions":"deny"}'::jsonb WHERE id = ${task.mandateId}::uuid`;
        } else {
          await sql`UPDATE auth.mandates SET policy = '{"version":1}'::jsonb WHERE id = ${task.mandateId}::uuid`;
        }
        expect(await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status })).toEqual({
          occurrenceId: occurrence.id,
          failed: status === "failed",
        });
        expect(await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status })).toBeNull();
        const finished = await aiChatTasks.get({ userId: user!.id, taskId: task.shortId });
        expect(finished?.state).toBe(status === "completed" ? "completed" : "needs_attention");
        const [liveMandate] = await sql<{ state: string }[]>`SELECT state FROM auth.mandates WHERE id = ${task.mandateId}::uuid`;
        expect(liveMandate?.state).toBe(
          condition === "stale" || condition === "narrowed" ? "paused" : condition === "revoked" ? "revoked" : "active",
        );
        if (condition === "legacy") expect(finished?.mandateId).toBeNull();
        expect(
          (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.mandates WHERE workload_id = ${task.id}`)[0]?.count,
        ).toBe(1);
        await sql`UPDATE auth.users SET account_expires = NULL WHERE id = ${user!.id}::uuid`;
      }
      expect(await aiChatTasks.listTerminalRunningTurns()).toEqual([]);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("never regenerates missing task authority and allows the owner to remove the task", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${"ai-hardcut-" + suffix}, 'local', 'user', 'Hard cut') RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Missing mandate" });
    try {
      const [task] = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO ai.chat_tasks (short_id, conversation_id, sponsor_user_id, prompt, schedule_kind, cron, timezone)
        VALUES (${createAiShortId()}, ${conversation.id}::uuid, ${user!.id}::uuid, 'Old task', 'cron', '0 9 * * *', 'UTC')
        RETURNING id, short_id
      `;
      await expect(aiChatTasks.update({ userId: user!.id, taskId: task!.short_id, prompt: "Changed while active" })).rejects.toThrow(
        "recreate the task",
      );
      expect(
        await aiChatTasks.createOccurrence({
          taskId: task!.id,
          scheduledFor: new Date().toISOString(),
          trigger: "manual",
          requestKey: suffix,
        }),
      ).toBeNull();
      const stopped = await aiChatTasks.get({ userId: user!.id, taskId: task!.short_id });
      expect(stopped?.state).toBe("needs_attention");
      expect(stopped?.mandateId).toBeNull();
      await expect(aiChatTasks.setState({ userId: user!.id, taskId: task!.short_id, state: "active" })).rejects.toThrow(
        "recreate the task",
      );
      await expect(aiChatTasks.update({ userId: user!.id, taskId: task!.short_id, prompt: "Changed" })).rejects.toThrow(
        "recreate the task",
      );
      const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.mandates WHERE workload_id = ${task!.id}`;
      expect(count?.count).toBe(0);
      expect(await aiChatTasks.delete({ userId: crypto.randomUUID(), taskId: task!.short_id })).toBe(false);
      expect(await aiChatTasks.delete({ userId: user!.id, taskId: task!.short_id })).toBe(true);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("runs in its chat and is removed with the chat", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`ai-task-${suffix}`}, 'local', 'user', 'AI Task Test', ${`ai-task-${suffix}@example.test`}, 'AI', 'Task')
      RETURNING id
    `;
    const conversation = await aiConversations.createConversation({
      ownerUserId: user!.id,
      title: "Scheduled work",
    });

    try {
      const runAt = new Date(Date.now() + 60_000).toISOString();
      const task = await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Check the release status.",
        schedule: { kind: "once", runAt },
        timezone: "Europe/Berlin",
        idempotencyKey: `test:${suffix}`,
      });
      expect(task?.shortId).toMatch(AI_SHORT_ID_PATTERN);
      expect(task?.chatId).toBe(conversation.shortId);
      expect(
        await sql<
          Array<{ owner_app_id: string; workload_type: string; workload_id: string; state: string; policy: unknown }>
        >`SELECT owner_app_id, workload_type, workload_id, state, policy FROM auth.mandates WHERE id = ${task!.mandateId}::uuid`,
      ).toEqual([
        {
          owner_app_id: "core",
          workload_type: "ai.chat-task",
          workload_id: task!.id,
          state: "active",
          policy: { version: 1, apps: "*", operations: "*", actions: "require_approval" },
        },
      ]);
      expect((await aiChatTasks.list({ userId: user!.id })).map((entry) => entry.shortId)).toEqual([task!.shortId]);

      const manualAt = new Date().toISOString();
      const manual = await aiChatTasks.createOccurrence({
        taskId: task!.id,
        scheduledFor: manualAt,
        trigger: "manual",
        requestKey: `manual:${task!.id}:${suffix}`,
      });
      expect(manual?.shortId).toMatch(AI_SHORT_ID_PATTERN);
      expect((await aiChatTasks.setState({ userId: user!.id, taskId: task!.shortId, state: "paused" }))?.state).toBe("paused");
      expect((await sql<{ state: string }[]>`SELECT state FROM auth.mandates WHERE id = ${task!.mandateId}::uuid`)[0]?.state).toBe(
        "paused",
      );
      expect((await aiChatTasks.listQueuedOccurrences()).some((entry) => entry.occurrence.id === manual!.id)).toBe(false);
      expect((await aiChatTasks.setState({ userId: user!.id, taskId: task!.shortId, state: "active" }))?.state).toBe("active");
      expect((await sql<{ state: string }[]>`SELECT state FROM auth.mandates WHERE id = ${task!.mandateId}::uuid`)[0]?.state).toBe(
        "active",
      );
      expect((await aiChatTasks.listQueuedOccurrences()).find((entry) => entry.occurrence.id === manual!.id)?.task.shortId).toBe(
        task!.shortId,
      );
      const [blockingTurn] = await sql<{ id: string }[]>`
        INSERT INTO ai.turns (short_id, conversation_id, status)
        VALUES (${createAiShortId()}, ${conversation.id}::uuid, 'queued')
        RETURNING id
      `;
      expect(
        await aiChatTasks.deliverOccurrence({
          occurrenceId: manual!.id,
          modelProfileId: "test-model",
          runConfig: { kind: "chat", input: task!.prompt, toolSource: { kind: "none" } },
          userMessage: { role: "user", content: [{ type: "text", text: task!.prompt }] },
          expectedRevision: (await aiChatTasks.get({ userId: user!.id, taskId: task!.shortId }))!.revision,
        }),
      ).toEqual({ delivered: false, reason: "busy" });
      await sql`UPDATE ai.turns SET status = 'aborted', completed_at = now() WHERE id = ${blockingTurn!.id}::uuid`;
      const manualDelivery = await aiChatTasks.deliverOccurrence({
        occurrenceId: manual!.id,
        modelProfileId: "test-model",
        runConfig: { kind: "chat", input: task!.prompt, toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: task!.prompt }] },
        expectedRevision: (await aiChatTasks.get({ userId: user!.id, taskId: task!.shortId }))!.revision,
      });
      expect(manualDelivery.delivered).toBe(true);
      if (!manualDelivery.delivered) throw new Error("Expected manual task occurrence to be delivered");
      await sql`UPDATE ai.turns SET status = 'completed', completed_at = now() WHERE id = ${manualDelivery.turnId}::uuid`;
      await aiChatTasks.finalizeTurn({ turnId: manualDelivery.turnId, status: "completed" });
      expect((await aiChatTasks.get({ userId: user!.id, taskId: task!.shortId }))?.state).toBe("active");

      await sql`UPDATE ai.chat_tasks SET run_at = now() - interval '1 minute' WHERE id = ${task!.id}::uuid`;
      const occurrence = (await aiChatTasks.materializeDueOnce()).find((entry) => entry.taskId === task!.id);
      expect(occurrence?.id).toBeDefined();
      expect((await aiChatTasks.materializeDueOnce()).find((entry) => entry.taskId === task!.id)?.id).toBe(occurrence!.id);
      const delivered = await aiChatTasks.deliverOccurrence({
        occurrenceId: occurrence!.id,
        modelProfileId: "test-model",
        runConfig: { kind: "chat", input: task!.prompt, toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: task!.prompt }] },
        expectedRevision: (await aiChatTasks.get({ userId: user!.id, taskId: task!.shortId }))!.revision,
      });
      if (!delivered.delivered) throw new Error("Expected scheduled task occurrence to be delivered");
      const [scheduledMessage] = await sql<{ meta: unknown }[]>`
        SELECT meta FROM ai.messages WHERE loop_id = ${delivered.turnId} AND role = 'user'
      `;
      expect(scheduledMessage?.meta).toEqual({
        scheduledTask: {
          taskId: task!.shortId,
          occurrenceId: occurrence!.shortId,
          scheduledFor: occurrence!.scheduledFor,
          trigger: "scheduled",
        },
      });
      expect(await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status: "completed" })).toEqual({
        occurrenceId: occurrence!.id,
        failed: false,
      });
      expect((await aiChatTasks.get({ userId: user!.id, taskId: task!.shortId }))?.state).toBe("completed");
      expect((await sql<{ state: string }[]>`SELECT state FROM auth.mandates WHERE id = ${task!.mandateId}::uuid`)[0]?.state).toBe(
        "paused",
      );

      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      const [counts] = await sql<{ tasks: number; occurrences: number }[]>`
        SELECT
          (SELECT count(*)::int FROM ai.chat_tasks WHERE id = ${task!.id}::uuid) AS tasks,
          (SELECT count(*)::int FROM ai.chat_task_occurrences WHERE id IN (${manual!.id}::uuid, ${occurrence!.id}::uuid)) AS occurrences
      `;
      expect(counts).toEqual({ tasks: 0, occurrences: 0 });
      expect((await sql<{ state: string }[]>`SELECT state FROM auth.mandates WHERE id = ${task!.mandateId}::uuid`)[0]?.state).toBe(
        "revoked",
      );
      const cascadeAudit = await sql<{ action: string; outcome: string; reason: string | null; metadata: unknown }[]>`
        SELECT action, outcome, reason, metadata
        FROM audit.events
        WHERE target_type = 'mandate' AND target_id = ${task!.mandateId}
          AND metadata->>'provenance' = 'ai.chat-task-cascade'
      `;
      expect(cascadeAudit).toEqual([
        {
          action: "mandate.revoke",
          outcome: "allowed",
          reason: "Scheduled chat task deleted",
          metadata: {
            ownerAppId: "core",
            workloadType: "ai.chat-task",
            workloadId: task!.id,
            provenance: "ai.chat-task-cascade",
          },
        },
      ]);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("keeps retries, lifecycle changes, and terminal recovery consistent", async () => {
    const suffix = crypto.randomUUID();
    const users = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES
        (${`ai-task-owner-${suffix}`}, 'local', 'user', 'AI Task Owner', ${`ai-task-owner-${suffix}@example.test`}, 'AI', 'Owner'),
        (${`ai-task-peer-${suffix}`}, 'local', 'user', 'AI Task Peer', ${`ai-task-peer-${suffix}@example.test`}, 'AI', 'Peer')
      RETURNING id
    `;
    const owner = users[0]!;
    const peer = users[1]!;
    const conversation = await aiConversations.createConversation({
      ownerUserId: owner.id,
      title: "Task recovery",
    });
    const peerConversation = await aiConversations.createConversation({
      ownerUserId: peer.id,
      title: "Peer tasks",
    });

    try {
      const createInput = {
        userId: owner.id,
        chatId: conversation.shortId,
        prompt: "Check recovery.",
        schedule: { kind: "cron" as const, cron: "0 9 * * 1" },
        timezone: "Europe/Berlin",
        idempotencyKey: `shared-${suffix}`,
      };
      const task = await aiChatTasks.create(createInput);
      expect((await aiChatTasks.create(createInput))?.id).toBe(task!.id);
      await expect(aiChatTasks.create({ ...createInput, prompt: "Different input" })).rejects.toBeInstanceOf(
        AiChatTaskIdempotencyConflictError,
      );
      expect(
        await aiChatTasks.create({ ...createInput, userId: peer.id, chatId: peerConversation.shortId, prompt: "Peer input" }),
      ).not.toBeNull();

      await aiChatTasks.setState({ userId: owner.id, taskId: task!.shortId, state: "paused" });
      expect(
        (
          await aiChatTasks.update({
            userId: owner.id,
            taskId: task!.shortId,
            prompt: "Updated while paused.",
          })
        )?.state,
      ).toBe("paused");
      await aiChatTasks.setState({ userId: owner.id, taskId: task!.shortId, state: "active" });
      const activeRevision = (await aiChatTasks.get({ userId: owner.id, taskId: task!.shortId }))!.revision;
      expect((await aiChatTasks.setState({ userId: owner.id, taskId: task!.shortId, state: "active" }))?.revision).toBe(activeRevision);

      const stale = await aiChatTasks.createOccurrence({
        taskId: task!.id,
        scheduledFor: new Date().toISOString(),
        trigger: "manual",
        requestKey: `manual:stale:${suffix}`,
      });
      await aiChatTasks.update({
        userId: owner.id,
        taskId: task!.shortId,
        schedule: { kind: "cron", cron: "0 9 * * 1" },
        timezone: "Europe/Berlin",
      });
      expect((await aiChatTasks.listOccurrences({ userId: owner.id, taskId: task!.shortId }))?.[0]?.state).toBe("queued");
      await aiChatTasks.getQueuedOccurrence(stale!.id);
      await aiChatTasks.update({ userId: owner.id, taskId: task!.shortId, prompt: "Updated before preflight failed." });
      expect(await aiChatTasks.failOccurrence({ occurrenceId: stale!.id, error: "Stale preflight" })).toBe("stale");
      expect((await aiChatTasks.listOccurrences({ userId: owner.id, taskId: task!.shortId }))?.[0]?.state).toBe("queued");
      const rebound = await aiChatTasks.getQueuedOccurrence(stale!.id);
      const staleDelivery = await aiChatTasks.deliverOccurrence({
        occurrenceId: stale!.id,
        modelProfileId: "test-model",
        runConfig: { kind: "chat", input: rebound!.task.prompt, toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: rebound!.task.prompt }] },
        expectedRevision: rebound!.task.revision,
      });
      if (!staleDelivery.delivered) throw new Error("Expected stale occurrence delivery");
      await aiChatTasks.update({ userId: owner.id, taskId: task!.shortId, prompt: "Newer task prompt." });
      await sql`
        UPDATE ai.turns SET status = 'failed', error = 'Old run failed', completed_at = now()
        WHERE id = ${staleDelivery.turnId}::uuid
      `;
      await aiChatTasks.finalizeTurn({ turnId: staleDelivery.turnId, status: "failed" });
      expect((await aiChatTasks.get({ userId: owner.id, taskId: task!.shortId }))?.state).toBe("active");

      const failed = await aiChatTasks.createOccurrence({
        taskId: task!.id,
        scheduledFor: new Date(Date.now() + 1).toISOString(),
        trigger: "manual",
        requestKey: `manual:failed:${suffix}`,
      });
      const failedDelivery = await aiChatTasks.deliverOccurrence({
        occurrenceId: failed!.id,
        modelProfileId: "test-model",
        runConfig: { kind: "chat", input: "Fail", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "Fail" }] },
        expectedRevision: (await aiChatTasks.get({ userId: owner.id, taskId: task!.shortId }))!.revision,
      });
      if (!failedDelivery.delivered) throw new Error("Expected failed occurrence delivery");
      await sql`
        UPDATE ai.turns SET status = 'failed', error = 'Model unavailable', completed_at = now()
        WHERE id = ${failedDelivery.turnId}::uuid
      `;
      expect(await aiChatTasks.listTerminalRunningTurns()).toContainEqual({
        turnId: failedDelivery.turnId,
        status: "failed",
      });
      await aiChatTasks.finalizeTurn({ turnId: failedDelivery.turnId, status: "failed" });
      const detail = await aiChatTasks.listOccurrences({ userId: owner.id, taskId: task!.shortId });
      expect(detail?.find((entry) => entry.id === failed!.id)?.error).toBe("Model unavailable");
      expect((await aiChatTasks.get({ userId: owner.id, taskId: task!.shortId }))?.state).toBe("needs_attention");
      expect((await aiChatTasks.setState({ userId: owner.id, taskId: task!.shortId, state: "active" }))?.state).toBe("active");

      await sql`UPDATE ai.chat_tasks SET state = 'completed' WHERE id = ${task!.id}::uuid`;
      expect((await aiChatTasks.update({ userId: owner.id, taskId: task!.shortId, prompt: "Still complete." }))?.state).toBe("completed");
      expect(
        (
          await aiChatTasks.update({
            userId: owner.id,
            taskId: task!.shortId,
            schedule: { kind: "once", runAt: new Date(Date.now() + 60_000).toISOString() },
            timezone: "Europe/Berlin",
          })
        )?.state,
      ).toBe("active");
      await sql`UPDATE ai.chat_tasks SET state = 'needs_attention' WHERE id = ${task!.id}::uuid`;
      expect(await aiChatTasks.setState({ userId: owner.id, taskId: task!.shortId, state: "active" })).toBeNull();
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id IN (${conversation.id}::uuid, ${peerConversation.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id IN (${owner.id}::uuid, ${peer.id}::uuid)`;
    }
  });
});
