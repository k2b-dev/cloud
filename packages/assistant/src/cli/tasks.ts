import { arg, command, confirmFlag, flag, readCliInput } from "@k2b/cloud/cli";
import type {
  AiChatTaskOccurrenceView as AssistantChatTaskOccurrence,
  AiChatTaskView as AssistantChatTask,
} from "@k2b/cloud/ai";
import { idempotentJsonRequest, jsonRequest, printRows, printValue, queryString, readApi, requireConfirmation } from "./shared";

type TaskDetail = { task: AssistantChatTask; occurrences: AssistantChatTaskOccurrence[] };
const path = (taskId: string, suffix = ""): string => `/tasks/${encodeURIComponent(taskId)}${suffix}`;
const localInstant = (instant: string, timezone: string): string =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date(instant))
    .replace(" ", "T");
const scheduleText = (task: AssistantChatTask): string =>
  task.schedule.kind === "once" ? localInstant(task.schedule.runAt, task.timezone) : task.schedule.cron;
const promptPreview = (prompt: string): string => {
  const line = prompt.replace(/\s+/gu, " ").trim();
  return line.length <= 120 ? line : `${line.slice(0, 117)}...`;
};

const scheduleInput = (at?: string, cron?: string): { kind: "once"; localAt: string } | { kind: "cron"; cron: string } | undefined => {
  if (at && cron) throw new Error("Use either --at or --cron, not both.");
  if (at) return { kind: "once", localAt: at };
  if (cron) return { kind: "cron", cron };
  return undefined;
};

const printTask = (ctx: Parameters<typeof printValue>[0], task: AssistantChatTask, verb?: string): void =>
  printValue(ctx, task, `${verb ? `${verb} ` : ""}${task.id}\t${task.state}\t${scheduleText(task)}\t${promptPreview(task.prompt)}`);

export const assistantTaskCommands = [
  command("tasks status", {
    summary: "Show the timezone used for new task schedules",
    async run({ ctx }) {
      const status = await readApi<{ timezone: string }>(ctx, "/tasks/status");
      printValue(ctx, status, status.timezone);
    },
  }),
  command("tasks list", {
    summary: "List scheduled Assistant tasks",
    flags: {
      chat: flag.string({ description: "Limit tasks to this chat ID" }),
      state: flag.enum(["active", "paused", "completed", "needs_attention"] as const),
      limit: flag.int({ default: 50, min: 1, max: 100 }),
    },
    async run({ ctx, flags }) {
      const tasks = await readApi<AssistantChatTask[]>(
        ctx,
        `/tasks${queryString({ chatId: flags.chat, state: flags.state, limit: flags.limit })}`,
      );
      printRows(
        ctx,
        tasks,
        tasks.map((task) => ({
          id: task.id,
          chat: task.chatId,
          state: task.state,
          schedule: scheduleText(task),
          timezone: task.timezone,
          prompt: promptPreview(task.prompt),
        })),
        [{ key: "id" }, { key: "chat" }, { key: "state" }, { key: "schedule" }, { key: "timezone" }, { key: "prompt" }],
      );
    },
  }),
  command("tasks get", {
    summary: "Show one scheduled task and its recent runs",
    args: { task: arg.required({ valueLabel: "task-id" }) },
    async run({ ctx, args }) {
      const detail = await readApi<TaskDetail>(ctx, path(args.task));
      if (ctx.options.output !== "text") return printValue(ctx, detail);
      ctx.print(`${detail.task.id}\t${detail.task.state}\t${scheduleText(detail.task)}\t${detail.task.timezone}`);
      ctx.print(detail.task.prompt);
      printRows(
        ctx,
        detail.occurrences,
        detail.occurrences.map((run) => ({
          id: run.id,
          trigger: run.trigger,
          state: run.state,
          scheduled: run.scheduledFor,
          error: run.error ?? "-",
        })),
        [{ key: "id" }, { key: "trigger" }, { key: "state" }, { key: "scheduled" }, { key: "error" }],
      );
    },
  }),
  command("tasks create", {
    summary: "Create a one-time or recurring task in a chat",
    flags: {
      chat: flag.string({ required: true, description: "Target chat ID" }),
      prompt: flag.input({ required: true, description: "Task prompt text or --prompt-file" }),
      at: flag.string({ description: "Local date and time in YYYY-MM-DDTHH:mm using app.timezone" }),
      cron: flag.string({ description: "Five-field recurring cron expression using app.timezone" }),
    },
    async run({ ctx, flags }) {
      const schedule = scheduleInput(flags.at, flags.cron);
      if (!schedule) throw new Error("Supply --at or --cron.");
      const prompt = await readCliInput(flags.prompt, { label: "task prompt", required: true, trimFinalNewline: true });
      const task = await readApi<AssistantChatTask>(ctx, "/tasks", idempotentJsonRequest("POST", { chatId: flags.chat, prompt, schedule }));
      printTask(ctx, task, "Created");
    },
  }),
  command("tasks update", {
    summary: "Update a scheduled task",
    args: { task: arg.required({ valueLabel: "task-id" }) },
    flags: {
      prompt: flag.input({ description: "Replacement prompt text or --prompt-file" }),
      at: flag.string({ description: "Replacement local date and time in YYYY-MM-DDTHH:mm" }),
      cron: flag.string({ description: "Replacement five-field cron expression" }),
    },
    async run({ ctx, args, flags }) {
      const schedule = scheduleInput(flags.at, flags.cron);
      const prompt = await readCliInput(flags.prompt, { label: "task prompt", trimFinalNewline: true });
      if (!schedule && prompt === undefined) throw new Error("Supply --prompt, --at, or --cron.");
      const task = await readApi<AssistantChatTask>(
        ctx,
        path(args.task),
        jsonRequest("PATCH", { ...(prompt === undefined ? {} : { prompt }), ...(schedule ? { schedule } : {}) }),
      );
      printTask(ctx, task, "Updated");
    },
  }),
  ...(["pause", "resume"] as const).map((operation) =>
    command(`tasks ${operation}`, {
      summary: `${operation === "pause" ? "Pause" : "Resume"} a scheduled task`,
      args: { task: arg.required({ valueLabel: "task-id" }) },
      async run({ ctx, args }) {
        const task = await readApi<AssistantChatTask>(ctx, path(args.task, `/${operation}`), jsonRequest("POST"));
        printTask(ctx, task, operation === "pause" ? "Paused" : "Resumed");
      },
    }),
  ),
  command("tasks run", {
    summary: "Queue one manual run without changing the schedule",
    args: { task: arg.required({ valueLabel: "task-id" }) },
    async run({ ctx, args }) {
      const occurrence = await readApi<AssistantChatTaskOccurrence>(ctx, path(args.task, "/run"), idempotentJsonRequest("POST"));
      printValue(ctx, occurrence, `Queued ${occurrence.id}.`);
    },
  }),
  command("tasks delete", {
    summary: "Delete a task and all of its run history",
    args: { task: arg.required({ valueLabel: "task-id" }) },
    flags: { yes: confirmFlag("Confirm deleting this task and all run history") },
    async run({ ctx, args, flags }) {
      requireConfirmation(flags.yes, "Deleting a scheduled task");
      const result = await readApi<{ deleted: true }>(ctx, path(args.task), { method: "DELETE" });
      printValue(ctx, result, `Deleted ${args.task}.`);
    },
  }),
];
