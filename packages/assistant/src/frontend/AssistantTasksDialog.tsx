import { dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { useLocale, Button, DateTimePicker, Placeholder, prompts, Select, StatusBadge, TextInput, toast } from "@k2b/ui";
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { assistantApi } from "../api/client";
import type {
  AiChatTaskOccurrenceView as AssistantChatTaskOccurrence,
  AiChatTaskView as AssistantChatTask,
} from "@valentinkolb/cloud/ai";
import { type AssistantLiveInvalidation, matchesAssistantInvalidation, useAssistantLive } from "./assistant-live";
import { assistantBrowserText, useAssistantCopy, useAssistantText } from "./ui-copy";

const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/api/ai${path}`, init);
  const body = (await response.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.message || assistantBrowserText("Scheduled task request failed"));
  return body;
};

const idempotencyKey = () => crypto.randomUUID().replaceAll("-", "");

const localDateTime = (instant: string, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
};

const statePresentation = (state: AssistantChatTask["state"], text: (value: string) => string) => {
  if (state === "active") return { label: text("Active"), tone: "ok" as const };
  if (state === "paused") return { label: text("Paused"), tone: "neutral" as const };
  if (state === "completed") return { label: text("Completed"), tone: "neutral" as const };
  return { label: text("Needs attention"), tone: "warning" as const };
};

const occurrencePresentation = (state: AssistantChatTaskOccurrence["state"], text: (value: string) => string) => {
  if (state === "completed") return { label: text("Completed"), tone: "ok" as const };
  if (state === "failed") return { label: text("Failed"), tone: "error" as const };
  if (state === "running") return { label: text("Running"), tone: "running" as const };
  return { label: text("Queued"), tone: "neutral" as const };
};

export const formatAssistantTaskSchedule = (task: AssistantChatTask, locale = "en"): string =>
  task.schedule.kind === "once"
    ? dates.formatDateTime(task.schedule.runAt, { locale, timeZone: task.timezone })
    : `${task.schedule.cron} · ${task.timezone}`;

export function AssistantTasksView(props: { chatId: string }) {
  const locale = useLocale();
  const text = useAssistantText();
  const copy = useAssistantCopy();
  const tasks = query.create<string, AssistantChatTask[], AssistantLiveInvalidation>({
    source: () => props.chatId,
    load: (chatId, { abortSignal }) => assistantApi.listChatTasks({ chatId, limit: 100, signal: abortSignal }),
  });
  const live = useAssistantLive();
  const unregister = live.register({
    matches: matchesAssistantInvalidation(["conversation-tasks"], { conversationId: props.chatId }),
    invalidate: async (invalidation) => {
      await Promise.all([tasks.invalidate(invalidation), history.invalidate(invalidation)]);
    },
  });
  onCleanup(unregister);
  const [timezone] = createResource(() => request<{ timezone: string }>("/tasks/status"));
  const [prompt, setPrompt] = createSignal("");
  const [kind, setKind] = createSignal<"once" | "cron">("once");
  const [runAt, setRunAt] = createSignal<string | null>(null);
  const [cron, setCron] = createSignal("0 9 * * 1-5");
  const [editing, setEditing] = createSignal<AssistantChatTask | null>(null);
  const [initialSchedule, setInitialSchedule] = createSignal("");
  const [submitted, setSubmitted] = createSignal(false);
  const [busyAction, setBusyAction] = createSignal<string | null>(null);
  const [formError, setFormError] = createSignal<string | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [historyTask, setHistoryTask] = createSignal<AssistantChatTask | null>(null);
  const history = query.create<
    string,
    { task: AssistantChatTask; occurrences: AssistantChatTaskOccurrence[] } | null,
    AssistantLiveInvalidation
  >({
    source: () => historyTask()?.id ?? "",
    load: async (taskId, { abortSignal }) => {
      if (!taskId) return null;
      const response = await fetch(`/api/ai/tasks/${taskId}`, { signal: abortSignal });
      if (response.status === 404) return null;
      const body = (await response.json().catch(() => null)) as {
        task: AssistantChatTask;
        occurrences: AssistantChatTaskOccurrence[];
        message?: string;
      } | null;
      if (!response.ok || !body) throw new Error(body?.message || text("Could not load occurrence history"));
      return body;
    },
  });
  const historyDetail = createMemo(() => {
    const selected = historyTask();
    const detail = history.data();
    return selected && detail?.task.id === selected.id ? detail : null;
  });

  createEffect(() => {
    const selected = historyTask();
    const current = tasks.data();
    if (selected && current && !current.some((task) => task.id === selected.id)) setHistoryTask(null);
  });

  const promptError = createMemo(() => (submitted() && !prompt().trim() ? text("Enter what Assistant should do.") : undefined));
  const scheduleError = createMemo(() => {
    if (!submitted()) return undefined;
    if (kind() === "once" && !runAt()) return text("Choose a future date and time.");
    if (kind() === "cron" && !cron().trim()) return text("Enter a five-field cron expression.");
    return undefined;
  });
  const busy = () => busyAction() !== null;

  const reset = () => {
    setEditing(null);
    setPrompt("");
    setKind("once");
    setRunAt(null);
    setCron("0 9 * * 1-5");
    setInitialSchedule("");
    setSubmitted(false);
    setFormError(null);
  };

  const edit = (task: AssistantChatTask) => {
    setEditing(task);
    setPrompt(task.prompt);
    setKind(task.schedule.kind);
    setRunAt(task.schedule.kind === "once" ? task.schedule.runAt : null);
    setCron(task.schedule.kind === "cron" ? task.schedule.cron : "0 9 * * 1-5");
    setInitialSchedule(JSON.stringify(task.schedule));
    setSubmitted(false);
    setFormError(null);
  };

  const scheduleInput = () => {
    if (kind() === "cron") return { kind: "cron" as const, cron: cron().trim() };
    const value = runAt();
    const zone = timezone()?.timezone;
    return value && zone ? { kind: "once" as const, localAt: localDateTime(value, zone) } : null;
  };

  const scheduleChanged = () => {
    const current = editing();
    if (!current) return true;
    if (kind() !== current.schedule.kind) return true;
    if (kind() === "once") return JSON.stringify({ kind: "once", runAt: runAt() }) !== initialSchedule();
    return JSON.stringify({ kind: "cron", cron: cron().trim() }) !== initialSchedule();
  };

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setFormError(null);
    const current = editing();
    const includeSchedule = !current || scheduleChanged();
    const schedule = includeSchedule ? scheduleInput() : null;
    if (!prompt().trim() || (includeSchedule && (!schedule || scheduleError()))) return;
    setBusyAction("save");
    try {
      await request(current ? `/tasks/${current.id}` : "/tasks", {
        method: current ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", ...(current ? {} : { "Idempotency-Key": idempotencyKey() }) },
        body: JSON.stringify(
          current
            ? { prompt: prompt().trim(), ...(includeSchedule && schedule ? { schedule } : {}) }
            : { chatId: props.chatId, prompt: prompt().trim(), schedule },
        ),
      });
      reset();
      await tasks.refresh();
      toast.success(text(current ? "Task updated" : "Task scheduled"));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : text("Could not save task"));
    } finally {
      setBusyAction(null);
    }
  };

  const action = async (task: AssistantChatTask, name: "pause" | "resume" | "run" | "delete") => {
    if (name === "delete" && !(await prompts.confirm(copy().deleteScheduledTask({ prompt: task.prompt.slice(0, 80) })))) return;
    setBusyAction(`${task.id}:${name}`);
    setActionError(null);
    try {
      await request(`/tasks/${task.id}${name === "delete" ? "" : `/${name}`}`, {
        method: name === "delete" ? "DELETE" : "POST",
        headers: name === "run" ? { "Idempotency-Key": idempotencyKey() } : undefined,
      });
      await tasks.refresh();
      if (name === "delete" && historyTask()?.id === task.id) {
        setHistoryTask(null);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : text("Could not update task"));
    } finally {
      setBusyAction(null);
    }
  };

  const showHistory = (task: AssistantChatTask) => {
    setHistoryTask(task);
    setActionError(null);
  };

  return (
    <div class="flex flex-col gap-6">
      <form class="flex flex-col gap-4 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-4" onSubmit={save}>
        <div>
          <h3 class="font-semibold text-primary">{text(editing() ? "Edit task" : "Schedule a task")}</h3>
          <p class="mt-1 text-sm text-secondary">{text("Tasks stay attached to this chat and use its current Project context when they run.")}</p>
        </div>
        <TextInput
          label={text("Prompt")}
          multiline
          lines={3}
          value={prompt}
          onValueChange={setPrompt}
          placeholder={text("What should Assistant do?")}
          maxLength={10_000}
          error={promptError}
          disabled={busy()}
        />
        <Select
          label={text("Schedule")}
          value={kind}
          onValueChange={(value) => value && setKind(value as "once" | "cron")}
          options={[
            { value: "once", label: text("Once"), icon: "ti ti-calendar-event" },
            { value: "cron", label: text("Recurring"), icon: "ti ti-repeat" },
          ]}
          disabled={busy()}
        />
        <Show
          when={kind() === "once"}
          fallback={
            <TextInput
              label={text("Cron expression")}
              description={`Five fields interpreted in ${timezone()?.timezone ?? "app.timezone"}.`}
              value={cron}
              onValueChange={setCron}
              placeholder="0 9 * * 1-5"
              monospace
              error={scheduleError}
              disabled={busy()}
            />
          }
        >
          <DateTimePicker
            label={text("Run at")}
            description={`Local time in ${timezone()?.timezone ?? "app.timezone"}.`}
            value={runAt}
            onValueChange={setRunAt}
            dateConfig={{ timeZone: timezone()?.timezone ?? "UTC" }}
            error={scheduleError}
            disabled={busy() || timezone.loading}
            clearable
          />
        </Show>
        <Show when={formError()}>
          {(message) => (
            <p class="text-sm text-red-600 dark:text-red-300" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <div class="flex justify-end gap-2">
          <Show when={editing()}>
            <Button type="button" variant="secondary" size="sm" onClick={reset} disabled={busy()}>
              {text("Cancel")}
            </Button>
          </Show>
          <Button type="submit" size="sm" loading={busyAction() === "save"} disabled={busy() && busyAction() !== "save"}>
            {text(editing() ? "Save task" : "Schedule task")}
          </Button>
        </div>
      </form>

      <Show when={actionError()}>{(message) => <Placeholder state="error" title={text("Task action failed")} description={message()} />}</Show>
      <Show
        when={tasks.data()}
        fallback={
          <Placeholder
            state={tasks.error() ? "error" : "loading"}
            title={text(tasks.error() ? "Could not load tasks" : "Loading tasks")}
            description={tasks.error()?.message}
          />
        }
      >
        {(items) => (
          <Show
            when={items().length > 0}
            fallback={<Placeholder title={text("No scheduled tasks")} description={text("Create a one-time or recurring task for this chat.")} />}
          >
            <div class="flex flex-col gap-5">
              <For each={items()}>
                {(task) => {
                  const state = () => statePresentation(task.state, text);
                  return (
                    <article class="flex flex-col gap-2">
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <p class="line-clamp-3 text-sm font-medium text-primary">{task.prompt}</p>
                          <p class="mt-1 text-xs text-dimmed">{formatAssistantTaskSchedule(task, locale())}</p>
                        </div>
                        <StatusBadge label={state().label} tone={state().tone} variant="chip" />
                      </div>
                      <Show when={task.lastError}>
                        {(message) => (
                          <p class="text-xs text-red-600 dark:text-red-300" role="alert">
                            {message()}
                          </p>
                        )}
                      </Show>
                      <div class="flex flex-wrap gap-1">
                        <Button size="xs" variant="ghost" onClick={() => edit(task)} disabled={busy()}>
                          {text("Edit")}
                        </Button>
                        <Show when={task.state === "active"}>
                          <Button
                            size="xs"
                            variant="ghost"
                            loading={busyAction() === `${task.id}:pause`}
                            onClick={() => void action(task, "pause")}
                            disabled={busy()}
                          >
                            {text("Pause")}
                          </Button>
                        </Show>
                        <Show when={task.state === "paused" || (task.state === "needs_attention" && task.schedule.kind === "cron")}>
                          <Button
                            size="xs"
                            variant="ghost"
                            loading={busyAction() === `${task.id}:resume`}
                            onClick={() => void action(task, "resume")}
                            disabled={busy()}
                          >
                            {text("Resume")}
                          </Button>
                        </Show>
                        <Button
                          size="xs"
                          variant="ghost"
                          loading={busyAction() === `${task.id}:run`}
                          disabled={busy() || task.state !== "active"}
                          onClick={() => void action(task, "run")}
                        >
                          {text("Run now")}
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => showHistory(task)} disabled={busy()}>
                          {text("History")}
                        </Button>
                        <Button
                          size="xs"
                          variant="danger"
                          loading={busyAction() === `${task.id}:delete`}
                          onClick={() => void action(task, "delete")}
                          disabled={busy()}
                        >
                          {text("Delete")}
                        </Button>
                      </div>
                    </article>
                  );
                }}
              </For>
            </div>
          </Show>
        )}
      </Show>

      <Show when={historyTask()}>
        {(task) => (
          <section class="flex flex-col gap-3" aria-live="polite">
            <div>
              <h3 class="font-semibold text-primary">{text("Occurrence history")}</h3>
              <p class="mt-1 line-clamp-2 text-sm text-secondary">{historyDetail()?.task.prompt ?? task().prompt}</p>
            </div>
            <Show
              when={historyDetail()}
              fallback={
                <Placeholder
                  state={history.error() ? "error" : "loading"}
                  title={text(history.error() ? "Could not load occurrence history" : "Loading occurrence history")}
                  description={history.error()?.message}
                />
              }
            >
              {(detail) => (
                <Show when={detail().occurrences.length > 0} fallback={<Placeholder title={text("No occurrences yet")} />}>
                  <ul class="flex flex-col gap-3">
                    <For each={detail().occurrences}>
                      {(item) => {
                        const state = () => occurrencePresentation(item.state, text);
                        return (
                          <li class="flex items-start justify-between gap-3 text-sm">
                            <span class="min-w-0">
                              <span class="block text-secondary">
                                {dates.formatDateTime(item.scheduledFor, { timeZone: detail().task.timezone })}
                              </span>
                              <Show when={item.error}>
                                {(message) => <span class="block text-xs text-red-600 dark:text-red-300">{message()}</span>}
                              </Show>
                            </span>
                            <StatusBadge label={state().label} tone={state().tone} variant="text" />
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </Show>
              )}
            </Show>
          </section>
        )}
      </Show>
    </div>
  );
}
