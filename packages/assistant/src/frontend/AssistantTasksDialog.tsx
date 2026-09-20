import { dates } from "@k2b/stdlib";
import { query, timed } from "@k2b/stdlib/solid";
import { useLocale, Button, Dropdown, NoticeCard, Placeholder, prompts, StatusBadge, Tabs, MarkdownView, toast } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { AiChatTaskOccurrenceView as AssistantChatTaskOccurrence, AiChatTaskView as AssistantChatTask } from "@k2b/cloud/ai";
import { assistantApi } from "../api/client";
import { navigateTo } from "@k2b/ssr/nav";
import { taskTab, workspaceSelectionHref } from "../artifacts/workspace-state";
import { assistantConversationHref } from "./assistant-navigation";
import { type AssistantLiveInvalidation, matchesAssistantInvalidation, useAssistantLive } from "./assistant-live";
import { assistantBrowserText, useAssistantCopy, useAssistantText } from "./ui-copy";

const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/api/ai${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(body?.message || assistantBrowserText("Scheduled task request failed"));
  return body;
};
export const assistantTaskTitle = (task: AssistantChatTask) => task.prompt.split(/\n|:\s/u)[0]!.slice(0, 80);
export const openAssistantTask = (task: AssistantChatTask) =>
  navigateTo(workspaceSelectionHref(assistantConversationHref("/app/assistant", task.chatId), taskTab(task.id, assistantTaskTitle(task))));
export const occurrencePresentation = (state: AssistantChatTaskOccurrence["state"], text: (value: string) => string) => {
  if (state === "completed") return { label: text("Completed"), tone: "ok" as const };
  if (state === "failed") return { label: text("Failed"), tone: "error" as const };
  if (state === "running") return { label: text("Running"), tone: "running" as const };
  return { label: text("Queued"), tone: "neutral" as const };
};
export const formatAssistantTaskSchedule = (task: AssistantChatTask, locale = "en"): string => {
  if (task.schedule.kind === "once") return locale.startsWith("de") ? "Einmalig" : "One-time";
  const [minute, hour, day, month, weekday] = task.schedule.cron.split(" ");
  const de = locale.startsWith("de");
  if (/^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "") && day === "*" && month === "*") {
    const time = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
    const weekdays = de
      ? ["Sonntags", "Montags", "Dienstags", "Mittwochs", "Donnerstags", "Freitags", "Samstags", "Sonntags"]
      : ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
    const label =
      weekday === "*"
        ? de
          ? "Täglich"
          : "Daily"
        : weekday === "1-5"
          ? de
            ? "Montag–Freitag"
            : "Monday–Friday"
          : /^\d$/.test(weekday ?? "")
            ? weekdays[Number(weekday)]
            : null;
    if (label) return `${de ? (weekday === "*" ? "Täglich" : "Immer " + label.toLowerCase()) : label} ${time}`;
  }
  return de ? "Wiederkehrend" : "Recurring";
};

const useTaskClock = () => {
  const [now, setNow] = createSignal(new Date());
  timed.interval(() => setNow(new Date()), 60_000);
  return now;
};
function TaskScheduleLine(props: { task: AssistantChatTask; now: Date }) {
  const locale = useLocale(),
    text = useAssistantText();
  const next = () => (props.task.state === "active" ? props.task.nextRunAt : null);
  return (
    <span
      title={
        next()
          ? dates.formatDateTime(next()!, { locale: locale(), timeZone: props.task.timezone }) + " · " + props.task.timezone
          : props.task.timezone
      }
    >
      <Show when={next()}>
        {(at) => (
          <>
            {text("Next run")}: {dates.formatTimeSpan(at(), { locale: locale(), base: props.now })} ·{" "}
          </>
        )}
      </Show>
      {formatAssistantTaskSchedule(props.task, locale())}
    </span>
  );
}

export function AssistantTasksView(props: {
  chatId: string;
  onOpenRun: (taskId: string, occurrenceId: string) => void;
  onOpenTask?: (task: AssistantChatTask) => void;
}) {
  const locale = useLocale(),
    text = useAssistantText();
  const now = useTaskClock();
  const tasks = query.create<string, AssistantChatTask[], AssistantLiveInvalidation>({
    source: () => props.chatId,
    load: (chatId, { abortSignal }) => assistantApi.listChatTasks({ chatId, limit: 100, signal: abortSignal }),
  });
  onCleanup(
    useAssistantLive().register({
      matches: matchesAssistantInvalidation(["conversation-tasks"], { conversationId: props.chatId }),
      invalidate: (invalidation) => tasks.invalidate(invalidation),
    }),
  );
  return (
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
        <div class="flex flex-col gap-2">
          <Show
            when={items().length}
            fallback={
              <Placeholder title={text("No scheduled tasks")} description={text("Ask in the chat for a reminder or a recurring task.")} />
            }
          >
            <For each={items()}>
              {(task) => (
                <Button
                  variant="ghost"
                  wrap
                  class="assistant-task-row"
                  onClick={() => (props.onOpenTask ? props.onOpenTask(task) : openAssistantTask(task))}
                >
                  <span class="flex w-full items-center gap-3 py-2">
                    <i class="ti ti-calendar-time shrink-0 text-secondary" aria-hidden="true" />
                    <span class="flex min-w-0 flex-1 flex-col gap-1">
                      <span class="truncate font-medium">{assistantTaskTitle(task)}</span>
                      <span class="text-xs font-normal text-secondary">
                        <TaskScheduleLine task={task} now={now()} />
                      </span>
                      <span
                        class="text-xs font-normal"
                        classList={{ "text-secondary": !task.lastError, "text-amber-700 dark:text-amber-300": Boolean(task.lastError) }}
                      >
                        {text(
                          task.lastError || task.state === "needs_attention"
                            ? "Needs attention"
                            : task.state === "paused"
                              ? "Paused"
                              : task.state === "completed"
                                ? "Completed"
                                : "Scheduled",
                        )}
                      </span>
                    </span>
                    <i class="ti ti-chevron-right ml-auto shrink-0 text-dimmed" aria-hidden="true" />
                  </span>
                </Button>
              )}
            </For>
          </Show>
          <p class="mt-3 text-xs text-secondary">{text("Plan new tasks and make changes in the chat.")}</p>
        </div>
      )}
    </Show>
  );
}

type TaskDetail = {
  task: AssistantChatTask;
  occurrences: AssistantChatTaskOccurrence[];
  permissions: { title: string; app: string; icon: string; mode: string; scope: string }[];
};
export function AssistantTaskDetail(props: {
  taskId: string;
  onOpenRun: (taskId: string, occurrenceId: string) => void;
  onEdit: (task: AssistantChatTask, repair: boolean) => void;
  onTitle?: (title: string) => void;
}) {
  const locale = useLocale(),
    text = useAssistantText(),
    copy = useAssistantCopy();
  const [tab, setTab] = createSignal("result"),
    [busy, setBusy] = createSignal<string | null>(null),
    [error, setError] = createSignal<string | null>(null);
  const now = useTaskClock();
  const [deleted, setDeleted] = createSignal(false);
  const detail = query.create({
    source: () => props.taskId,
    load: (id, { abortSignal }) => request<TaskDetail>(`/tasks/${id}`, { signal: abortSignal }),
  });
  onCleanup(
    useAssistantLive().register({
      matches: matchesAssistantInvalidation(["conversation-tasks"]),
      invalidate: async () => {
        await detail.refresh();
      },
    }),
  );
  createEffect(() => {
    const task = detail.data()?.task;
    if (task) props.onTitle?.(assistantTaskTitle(task));
  });
  const action = async (task: AssistantChatTask, name: "pause" | "resume" | "run" | "delete") => {
    if (name === "delete" && !(await prompts.confirm(copy().deleteScheduledTask({ prompt: assistantTaskTitle(task) })))) return;
    setBusy(name);
    setError(null);
    try {
      await request(`/tasks/${task.id}${name === "delete" ? "" : `/${name}`}`, {
        method: name === "delete" ? "DELETE" : "POST",
        headers: name === "run" ? { "Idempotency-Key": crypto.randomUUID().replaceAll("-", "") } : undefined,
      });
      if (name === "run") {
        setTab("result");
        toast.success(text("Task queued. The result will appear here and in the chat when it is ready."), {
          title: text("Scheduled task"),
        });
      }
      if (name === "delete") setDeleted(true);
      else await detail.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : text("Could not update task"));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Show when={!deleted()} fallback={<Placeholder title={text("Task deleted")} />}>
      <Show
        when={detail.data()}
        fallback={
          <Placeholder
            state={detail.error() ? "error" : "loading"}
            title={text(detail.error() ? "Task unavailable" : "Loading tasks")}
            description={detail.error()?.message}
          />
        }
      >
        {(value) => {
          const task = () => value().task,
            latest = () => value().occurrences[0];
          return (
            <div class="assistant-task-detail">
              <div class="assistant-task-detail__body">
                <div>
                  <p class="assistant-task-detail__instructions">{task().prompt}</p>
                  <div class="mt-3 flex flex-wrap items-center gap-2">
                    <Show
                      when={value().occurrences.find((run) => run.state === "running" || run.state === "queued")}
                      fallback={
                        <Show when={task().state !== "active"}>
                          <StatusBadge
                            variant="chip"
                            tone="neutral"
                            label={text(
                              task().state === "paused" ? "Paused" : task().state === "completed" ? "Completed" : "Needs attention",
                            )}
                          />
                        </Show>
                      }
                    >
                      {(run) => <StatusBadge variant="chip" {...occurrencePresentation(run().state, text)} />}
                    </Show>
                    <span class="text-xs text-secondary">
                      <TaskScheduleLine task={task()} now={now()} />
                    </span>
                  </div>
                </div>
                <Show when={task().lastError || latest()?.state === "failed"}>
                  <NoticeCard
                    tone="warning"
                    title={text("Run needs attention")}
                    detail={text("Review the result before retrying. The task may have completed some steps.")}
                  />
                  <Button variant="secondary" size="sm" onClick={() => props.onEdit(task(), true)}>
                    {text("Resolve in chat")}
                  </Button>
                </Show>

                <Tabs
                  variant="pill"
                  ariaLabel={text("Scheduled task")}
                  value={tab}
                  onValueChange={setTab}
                  options={[
                    { value: "result", label: text("Latest result") },
                    { value: "history", label: text("History") },
                    { value: "access", label: text("Access") },
                  ]}
                />
                <Show when={tab() === "result"}>
                  <Show when={latest()} fallback={<Placeholder title={text("No occurrences yet")} />}>
                    {(run) => (
                      <>
                        <div class="flex items-center justify-between gap-2 text-xs text-secondary">
                          <time>{dates.formatDateTime(run().scheduledFor, { locale: locale(), timeZone: task().timezone })}</time>
                          <StatusBadge {...occurrencePresentation(run().state, text)} variant="text" />
                        </div>
                        <Show
                          when={run().resultText || run().error}
                          fallback={<p class="text-sm text-secondary">{text("The result will appear here and in the chat.")}</p>}
                        >
                          {(result) => <MarkdownView markdown={result()} headingScale="compact" />}
                        </Show>
                      </>
                    )}
                  </Show>
                </Show>
                <Show when={tab() === "history"}>
                  <Show when={value().occurrences.length} fallback={<Placeholder title={text("No occurrences yet")} />}>
                    <For each={value().occurrences}>
                      {(run) => (
                        <Button
                          variant="ghost"
                          wrap
                          class="w-full !justify-start [&>.k2b-button__label]:w-full"
                          onClick={() => props.onOpenRun(task().id, run.id)}
                        >
                          <span class="flex w-full items-center justify-between gap-3">
                            <time class="text-sm">
                              {dates.formatDateTime(run.scheduledFor, { locale: locale(), timeZone: task().timezone })}
                            </time>
                            <StatusBadge {...occurrencePresentation(run.state, text)} variant="text" />
                          </span>
                        </Button>
                      )}
                    </For>
                  </Show>
                </Show>
                <Show when={tab() === "access"}>
                  <Show when={value().permissions.length} fallback={<p class="text-sm text-secondary">{text("No additional access.")}</p>}>
                    <For each={value().permissions}>
                      {(permission) => (
                        <div class="flex items-start gap-3 py-2">
                          <i class={permission.icon} aria-hidden="true" />
                          <div class="min-w-0">
                            <p class="text-sm font-medium">{permission.title}</p>
                            <div class="mt-1 flex flex-wrap items-center gap-2">
                              <span class="text-xs text-secondary">{permission.app}</span>
                              <StatusBadge tone="neutral" variant="chip" label={permission.mode} />
                            </div>
                            <p class="mt-2 whitespace-pre-wrap break-words text-xs text-secondary">{permission.scope}</p>
                          </div>
                        </div>
                      )}
                    </For>
                  </Show>
                  <p class="text-xs text-secondary">
                    {text("Additional access requires your approval. Your existing access rights still apply.")}
                  </p>
                </Show>
                <Show when={error()}>
                  {(message) => <NoticeCard tone="danger" title={text("Task action failed")} detail={message()} />}
                </Show>
              </div>
              <div class="assistant-task-detail__actions">
                <Button variant="secondary" size="sm" onClick={() => props.onEdit(task(), false)}>
                  {text("Adjust in chat")}
                </Button>
                <Show
                  when={
                    task().state === "active" ||
                    task().state === "paused" ||
                    (task().state === "needs_attention" && task().schedule.kind === "cron")
                  }
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(busy())}
                    loading={busy() === "pause" || busy() === "resume"}
                    onClick={() => void action(task(), task().state === "active" ? "pause" : "resume")}
                  >
                    {text(task().state === "active" ? "Pause" : "Resume")}
                  </Button>
                </Show>
                <Dropdown.Root
                  items={[
                    {
                      label: text("Run now"),
                      icon: "ti ti-player-play",
                      disabled: Boolean(busy()) || task().state !== "active",
                      action: () => void action(task(), "run"),
                    },
                    {
                      label: text("Delete"),
                      icon: "ti ti-trash",
                      variant: "danger",
                      disabled: Boolean(busy()),
                      action: () => void action(task(), "delete"),
                    },
                  ]}
                >
                  <Dropdown.Trigger iconOnly label={text("More actions")}>
                    <i class="ti ti-dots" aria-hidden="true" />
                  </Dropdown.Trigger>
                </Dropdown.Root>
              </div>
            </div>
          );
        }}
      </Show>
    </Show>
  );
}
