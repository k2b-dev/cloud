import {
  AiChatTaskIdempotencyConflictError,
  AiConversationIdSchema,
  ChatTaskIdSchema,
  ChatTaskScheduleInputSchema as ScheduleInputSchema,
  aiChatTasks,
  chatTaskCreateFingerprint,
  getChatTaskTimezone,
  normalizeChatTaskSchedule,
  toAiChatTaskOccurrenceView,
  toAiChatTaskView,
} from "@k2b/cloud/ai";
import { CapabilityIdempotencyKeySchema, capabilityIdempotencyConflict } from "@k2b/cloud/contracts";
import { type AuthContext, auth, err, fail, ok, rateLimit, respond, v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { aiChatTaskRuntime, reconcileAiChatTasks } from "./ai-chat-tasks-runtime";

const APP_ID = "core";
const CreateSchema = z
  .object({ chatId: AiConversationIdSchema, prompt: z.string().trim().min(1).max(10_000), schedule: ScheduleInputSchema })
  .strict();
const UpdateSchema = z
  .object({ prompt: z.string().trim().min(1).max(10_000).optional(), schedule: ScheduleInputSchema.optional() })
  .strict()
  .refine((value) => value.prompt !== undefined || value.schedule !== undefined, "Provide a prompt or schedule");
const ListSchema = z
  .object({
    chatId: AiConversationIdSchema.optional(),
    state: z.enum(["active", "paused", "completed", "needs_attention"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const userId = (c: Context<AuthContext>): string | null => {
  const actor = c.get("actor");
  return actor.kind === "user" ? actor.user.id : (actor.delegatedUser?.id ?? null);
};

const reconcileSoon = (): void => {
  void reconcileAiChatTasks().catch(() => undefined);
};

export const aiChatTaskRoutes = new Hono<AuthContext>()
  .use(rateLimit())
  .use("*", auth.requireRole("authenticated"))
  .use("*", auth.requireUser())
  .get("/tasks", v("query", ListSchema), async (c) => {
    const owner = userId(c);
    if (!owner) return respond(c, fail(err.forbidden("Scheduled tasks require a user-backed actor")));
    const query = c.req.valid("query");
    return respond(c, ok((await aiChatTasks.list({ userId: owner, ...query })).map(toAiChatTaskView)));
  })
  .get("/tasks/status", async (c) => {
    const owner = userId(c);
    if (!owner) return respond(c, fail(err.forbidden("Scheduled tasks require a user-backed actor")));
    return respond(c, ok({ timezone: await getChatTaskTimezone() }));
  })
  .post("/tasks", v("json", CreateSchema), async (c) => {
    const owner = userId(c);
    if (!owner) return respond(c, fail(err.forbidden("Scheduled tasks require a user-backed actor")));
    const input = c.req.valid("json");
    const idempotencyKey = CapabilityIdempotencyKeySchema.safeParse(c.req.header("Idempotency-Key"));
    if (!idempotencyKey.success) return respond(c, fail(err.badInput("A valid Idempotency-Key is required")));
    const idempotencyFingerprint = chatTaskCreateFingerprint(input);
    try {
      const replay = await aiChatTasks.getCreateByIdempotency({
        userId: owner,
        idempotencyKey: idempotencyKey.data,
        idempotencyFingerprint,
      });
      if (replay) return respond(c, ok(toAiChatTaskView(replay)), 201);
    } catch (error) {
      if (error instanceof AiChatTaskIdempotencyConflictError) return respond(c, fail(capabilityIdempotencyConflict(error.message)));
      throw error;
    }
    let normalized: Awaited<ReturnType<typeof normalizeChatTaskSchedule>>;
    try {
      normalized = await normalizeChatTaskSchedule(input.schedule);
    } catch (error) {
      return respond(c, fail(err.badInput(error instanceof Error ? error.message : "Invalid schedule")));
    }
    let task: Awaited<ReturnType<typeof aiChatTasks.create>>;
    try {
      task = await aiChatTasks.create({
        userId: owner,
        chatId: input.chatId,
        prompt: input.prompt,
        ...normalized,
        idempotencyKey: idempotencyKey.data,
        idempotencyFingerprint,
      });
    } catch (error) {
      if (error instanceof AiChatTaskIdempotencyConflictError) return respond(c, fail(capabilityIdempotencyConflict(error.message)));
      throw error;
    }
    if (!task) return respond(c, fail(err.notFound("Chat")));
    reconcileSoon();
    return respond(c, ok(toAiChatTaskView(task)), 201);
  })
  .get("/tasks/:taskId", async (c) => {
    const owner = userId(c);
    if (!owner) return respond(c, fail(err.forbidden("Scheduled tasks require a user-backed actor")));
    const parsed = ChatTaskIdSchema.safeParse(c.req.param("taskId"));
    if (!parsed.success) return respond(c, fail(err.badInput("Invalid task ID")));
    const task = await aiChatTasks.get({ userId: owner, taskId: parsed.data });
    if (!task) return respond(c, fail(err.notFound("Task")));
    const occurrences = await aiChatTasks.listOccurrences({ userId: owner, taskId: parsed.data });
    return respond(
      c,
      ok({
        task: toAiChatTaskView(task),
        occurrences: (occurrences ?? []).map((entry) => toAiChatTaskOccurrenceView(entry, task.shortId)),
      }),
    );
  })
  .patch("/tasks/:taskId", v("json", UpdateSchema), async (c) => {
    const owner = userId(c);
    if (!owner) return respond(c, fail(err.forbidden("Scheduled tasks require a user-backed actor")));
    const parsed = ChatTaskIdSchema.safeParse(c.req.param("taskId"));
    if (!parsed.success) return respond(c, fail(err.badInput("Invalid task ID")));
    const input = c.req.valid("json");
    let normalized: Partial<Awaited<ReturnType<typeof normalizeChatTaskSchedule>>> = {};
    try {
      if (input.schedule) normalized = await normalizeChatTaskSchedule(input.schedule);
    } catch (error) {
      return respond(c, fail(err.badInput(error instanceof Error ? error.message : "Invalid schedule")));
    }
    const task = await aiChatTasks.update({ userId: owner, taskId: parsed.data, prompt: input.prompt, ...normalized });
    if (!task) return respond(c, fail(err.notFound("Task")));
    reconcileSoon();
    return respond(c, ok(toAiChatTaskView(task)));
  })
  .delete("/tasks/:taskId", async (c) => {
    const owner = userId(c);
    if (!owner) return respond(c, fail(err.forbidden("Scheduled tasks require a user-backed actor")));
    const parsed = ChatTaskIdSchema.safeParse(c.req.param("taskId"));
    if (!parsed.success) return respond(c, fail(err.badInput("Invalid task ID")));
    if (!(await aiChatTasks.delete({ userId: owner, taskId: parsed.data }))) return respond(c, fail(err.notFound("Task")));
    reconcileSoon();
    return respond(c, ok({ deleted: true }));
  })
  .post("/tasks/:taskId/pause", async (c) => {
    const owner = userId(c);
    if (!owner) return respond(c, fail(err.forbidden("Scheduled tasks require a user-backed actor")));
    const parsed = ChatTaskIdSchema.safeParse(c.req.param("taskId"));
    if (!parsed.success) return respond(c, fail(err.badInput("Invalid task ID")));
    const current = await aiChatTasks.get({ userId: owner, taskId: parsed.data });
    if (!current) return respond(c, fail(err.notFound("Task")));
    if (current.state !== "active" && current.state !== "paused")
      return respond(c, fail(err.conflict(`Task ${current.shortId} cannot be paused while ${current.state}`)));
    const task = await aiChatTasks.setState({ userId: owner, taskId: parsed.data, state: "paused" });
    if (!task) return respond(c, fail(err.conflict("Task state changed; read it and retry")));
    reconcileSoon();
    return respond(c, ok(toAiChatTaskView(task)));
  })
  .post("/tasks/:taskId/resume", async (c) => {
    const owner = userId(c);
    if (!owner) return respond(c, fail(err.forbidden("Scheduled tasks require a user-backed actor")));
    const parsed = ChatTaskIdSchema.safeParse(c.req.param("taskId"));
    if (!parsed.success) return respond(c, fail(err.badInput("Invalid task ID")));
    const current = await aiChatTasks.get({ userId: owner, taskId: parsed.data });
    if (!current) return respond(c, fail(err.notFound("Task")));
    if (current.state === "needs_attention" && current.schedule.kind === "once")
      return respond(c, fail(err.conflict(`Task ${current.shortId} needs a new future schedule before it can resume`)));
    if (current.state === "completed")
      return respond(c, fail(err.conflict(`Task ${current.shortId} cannot be resumed while ${current.state}`)));
    const task = await aiChatTasks.setState({ userId: owner, taskId: parsed.data, state: "active" });
    if (!task) return respond(c, fail(err.conflict("Task state changed; read it and retry")));
    reconcileSoon();
    return respond(c, ok(toAiChatTaskView(task)));
  })
  .post("/tasks/:taskId/run", async (c) => {
    const owner = userId(c);
    if (!owner) return respond(c, fail(err.forbidden("Scheduled tasks require a user-backed actor")));
    const parsed = ChatTaskIdSchema.safeParse(c.req.param("taskId"));
    if (!parsed.success) return respond(c, fail(err.badInput("Invalid task ID")));
    const task = await aiChatTasks.get({ userId: owner, taskId: parsed.data });
    if (!task) return respond(c, fail(err.notFound("Task")));
    const key = CapabilityIdempotencyKeySchema.safeParse(c.req.header("Idempotency-Key"));
    if (!key.success) return respond(c, fail(err.badInput("A valid Idempotency-Key is required")));
    let occurrence: Awaited<ReturnType<typeof aiChatTasks.createOccurrence>>;
    try {
      occurrence = await aiChatTasks.createOccurrence({
        taskId: task.id,
        scheduledFor: new Date().toISOString(),
        trigger: "manual",
        requestKey: `manual:${APP_ID}:${owner}:${key.data}`,
      });
    } catch (error) {
      if (error instanceof AiChatTaskIdempotencyConflictError) return respond(c, fail(capabilityIdempotencyConflict(error.message)));
      throw error;
    }
    if (!occurrence) return respond(c, fail(err.conflict("The task is not active or already has a queued or running occurrence")));
    void aiChatTaskRuntime.recover().catch(() => undefined);
    return respond(c, ok(toAiChatTaskOccurrenceView(occurrence, task.shortId)));
  });
