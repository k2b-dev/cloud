import type { JobContext, Worker } from "@k2b/sync";
import { lazySync } from "@k2b/cloud";
import { aiChatTasks, aiConversations, aiProjects, personalAiModelPolicy } from "@k2b/cloud/ai";
import { enqueueExistingAiTurn, validateAiTurnRequest } from "@k2b/cloud/ai/runtime";
import { accounts, coreSettings, logger } from "@k2b/cloud/services";
import { isAccountExpired } from "@k2b/cloud/services/account-model";
import { deliverPendingAiMessages } from "./ai-inter-chat-messages";

const APP_ID = "core";
const RECOVERY_ID = "core:ai-chat-tasks:recover";
const SCHEDULE_PREFIX = "task:";
const log = logger("core:ai-chat-tasks");
const recoveryStep = async <T>(step: string, run: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await run();
  } catch (error) {
    log.warn("Scheduled chat task recovery step failed", { step, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
};

const taskMandate = (task: { mandateId: string | null; mandateRevision: number | null }): { id: string; revision: number } => {
  if (!task.mandateId || task.mandateRevision === null) throw new Error("Scheduled task mandate is unavailable");
  return { id: task.mandateId, revision: task.mandateRevision };
};

const taskScheduler = lazySync((sync) => {
  const handle = sync.scheduler({ id: "core-ai-chat-tasks", delivery: { maxAttempts: 1 } });

  return handle;
});
const reconcileMutex = lazySync((sync) => sync.mutex({ id: "core:ai-chat-tasks:reconcile", ttlMs: 60_000, retry: { maxAttempts: 1 } }));
let started = false;
let workers: Worker[] = [];

const taskJob = lazySync((sync) => {
  const handle = sync.job<{ occurrenceId: string }>({
    id: "core-ai-chat-task-occurrence",
    delivery: { ackWaitMs: 60_000, maxAttempts: 3, backoffMs: [5_000, 10_000] },
  });

  return handle;
});
const processOccurrence = async (ctx: JobContext<{ occurrenceId: string }>) => {
  const pending = await aiChatTasks.getQueuedOccurrence(ctx.input.occurrenceId);
  if (!pending) return { status: "gone" as const, retry: false };
  const { occurrence, task } = pending;
  const [user, conversation] = await Promise.all([
    accounts.users.get({ id: task.sponsorUserId }),
    aiConversations.getConversation({ conversationId: task.conversationId, ownerUserId: task.sponsorUserId }),
  ]);
  if (!user || isAccountExpired(user.accountExpires) || !conversation) {
    const status = await aiChatTasks.failOccurrence({ occurrenceId: occurrence.id, error: "Task sponsor or chat is unavailable" });
    return { status: status === "gone" ? ("not_found" as const) : status, retry: status === "stale" };
  }
  const project = conversation.projectId ? await aiProjects.snapshot(conversation.projectId, { type: "user", userId: user.id }) : null;
  if (conversation.projectId && !project) {
    const status = await aiChatTasks.failOccurrence({ occurrenceId: occurrence.id, error: "Current Project access is unavailable" });
    return { status: status === "gone" ? ("not_found" as const) : status, retry: status === "stale" };
  }
  const text = `Scheduled task ${task.shortId} (${occurrence.scheduledFor}):\n\n${task.prompt}`;
  const { resolved } = await validateAiTurnRequest({
    input: text,
    modelPolicy: personalAiModelPolicy,
    requestedModelId: project?.defaultModelProfileId ?? undefined,
  });
  const delivered = await aiChatTasks.deliverOccurrence({
    occurrenceId: occurrence.id,
    modelProfileId: resolved.profile.id,
    runConfig: {
      kind: "chat",
      input: text,
      chatId: conversation.shortId,
      actor: { kind: "user", user },
      modelPolicy: personalAiModelPolicy,
      requestedModelId: project?.defaultModelProfileId ?? undefined,
      project: project ?? undefined,
      toolSource: { kind: "default", appTools: true },
      toolApprovalContext: { actorUserId: user.id },
      mandate: taskMandate(task),
    },
    userMessage: { role: "user", content: [{ type: "text", text }] },
    expectedRevision: task.revision,
  });
  if (!delivered.delivered)
    return {
      status: delivered.reason,
      retry: delivered.reason === "busy" || delivered.reason === "stale",
    };
  await enqueueExistingAiTurn({ conversationId: delivered.conversationId, turnId: delivered.turnId });
  return { status: "delivered" as const, retry: false };
};
const startTaskWorker = () =>
  taskJob().process({}, async (ctx) => {
    try {
      const result = await processOccurrence(ctx);
      if (result.retry) await ctx.resubmit({ delayMs: 60_000 });
    } catch (error) {
      if (ctx.attempt < 3) throw error;
      // Persist the terminal domain outcome before transport settlement. A stale
      // revision is a fresh continuation, not a failed delivery attempt.
      const status = await aiChatTasks.failOccurrence({
        occurrenceId: ctx.input.occurrenceId,
        error: error instanceof Error ? error.message : "Scheduled task delivery failed",
      });
      if (status === "stale") await ctx.resubmit({ delayMs: 60_000 });
      else throw error;
    }
  });

const submitOccurrence = async (occurrenceId: string): Promise<string> =>
  (await taskJob().submit({ key: `occurrence:${occurrenceId}`, input: { occurrenceId }, coalesce: true })).jobId;

const registerRecurringTask = async (task: Awaited<ReturnType<typeof aiChatTasks.listActiveCron>>[number]): Promise<void> => {
  if (task.schedule.kind !== "cron") return;
  await taskScheduler().create({
    id: `${SCHEDULE_PREFIX}${task.id}`,
    cron: task.schedule.cron,
    timezone: task.timezone,
    misfire: "latest",
    meta: {
      appId: APP_ID,
      family: "ai:chat-task",
      resourceKind: "chat-task",
      resourceId: task.shortId,
      resourceLabel: task.prompt.slice(0, 200),
    },
    process: async (ctx) => {
      const slot = ctx.slot.toISOString();
      const occurrence = await aiChatTasks.createOccurrence({
        taskId: task.id,
        scheduledFor: slot,
        trigger: "scheduled",
        requestKey: `cron:${task.id}:${slot}`,
        expectedRevision: task.revision,
      });
      if (occurrence?.state === "queued") await submitOccurrence(occurrence.id);
    },
  });
};

export const reconcileAiChatTaskSchedules = async (input: {
  tasks: Awaited<ReturnType<typeof aiChatTasks.listActiveCron>>;
  register: typeof registerRecurringTask;
  list: () => Promise<Array<{ id: string }>>;
  remove: (id: string) => Promise<unknown>;
  removeObsolete: boolean;
}): Promise<void> => {
  const desired = new Set(input.tasks.map((task) => `${SCHEDULE_PREFIX}${task.id}`));
  for (const task of input.tasks) await recoveryStep(`register:${task.id}`, () => input.register(task));
  if (!input.removeObsolete) return;
  const current = await recoveryStep("list-schedules", input.list);
  for (const schedule of current ?? []) {
    if (schedule.id.startsWith(SCHEDULE_PREFIX) && !desired.has(schedule.id)) {
      await recoveryStep(`remove-schedule:${schedule.id}`, () => input.remove(schedule.id));
    }
  }
};

export const reconcileAiChatTasks = async (): Promise<void> => {
  const lock = await reconcileMutex().acquire({ resource: APP_ID, ttlMs: 60_000 });
  if (!lock) return;
  try {
    const tasks = await aiChatTasks.listActiveCron();
    await reconcileAiChatTaskSchedules({
      tasks,
      register: registerRecurringTask,
      list: () => taskScheduler().list(),
      remove: (id) => taskScheduler().delete({ id }),
      removeObsolete: true,
    });
  } finally {
    await reconcileMutex()
      .release(lock)
      .catch(() => undefined);
  }
};

type RecoveryDependencies = {
  reconcile: () => Promise<void>;
  listTerminal: typeof aiChatTasks.listTerminalRunningTurns;
  finalize: (terminal: Awaited<ReturnType<typeof aiChatTasks.listTerminalRunningTurns>>[number]) => Promise<unknown>;
  materialize: () => Promise<unknown>;
  listQueued: () => Promise<Array<{ occurrence: { id: string } }>>;
  submit: (occurrenceId: string) => Promise<unknown>;
  deliverMessages: () => Promise<unknown>;
};
export const recoverAiChatTasks = async (dependencies: RecoveryDependencies): Promise<{ queued: number }> => {
  await recoveryStep("reconcile", dependencies.reconcile);
  const terminal = await recoveryStep("list-terminal", dependencies.listTerminal);
  for (const occurrence of terminal ?? []) {
    await recoveryStep(`finalize:${occurrence.turnId}`, () => dependencies.finalize(occurrence));
  }
  await recoveryStep("materialize", dependencies.materialize);
  const queued = await recoveryStep("list-queued", dependencies.listQueued);
  let submitted = 0;
  for (const { occurrence } of queued ?? []) {
    const accepted = await recoveryStep(`submit:${occurrence.id}`, async () => {
      await dependencies.submit(occurrence.id);
      return true;
    });
    if (accepted) submitted += 1;
  }
  await recoveryStep("deliver-messages", dependencies.deliverMessages);
  return { queued: submitted };
};
const recover = (): Promise<{ queued: number }> =>
  recoverAiChatTasks({
    reconcile: reconcileAiChatTasks,
    listTerminal: () => aiChatTasks.listTerminalRunningTurns(),
    finalize: (terminal) => aiChatTasks.finalizeTurn(terminal),
    materialize: () => aiChatTasks.materializeDueOnce(),
    listQueued: () => aiChatTasks.listQueuedOccurrences(),
    submit: submitOccurrence,
    deliverMessages: () => deliverPendingAiMessages(),
  });

export const aiChatTaskRuntime = {
  start: async (): Promise<void> => {
    if (started) return;

    try {
      const timezone = String((await coreSettings.get<string>("app.timezone")) || "").trim() || "UTC";
      await reconcileAiChatTasks();
      await taskScheduler().create({
        id: RECOVERY_ID,
        cron: "* * * * *",
        timezone,
        misfire: "latest",
        meta: { appId: APP_ID, family: "ai:chat-task", label: "Scheduled chat task recovery" },
        process: async () => {
          await recover();
        },
      });
      workers.push(await startTaskWorker());
      workers.push(await taskScheduler().process());
      started = true;
    } catch (error) {
      for (const worker of workers) worker.stop();
      await Promise.all(workers.map((worker) => worker.drain()));
      workers = [];
      started = false;
      throw error;
    }
  },

  stop: async (): Promise<void> => {
    if (!started) return;
    for (const worker of workers) worker.stop();
    await Promise.all(workers.map((worker) => worker.drain()));
    workers = [];
    started = false;
  },

  recover,
} as const;
