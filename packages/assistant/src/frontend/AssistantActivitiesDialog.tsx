import type { AiChatTaskOccurrenceView, AiChatTaskView, AiStoredMessage } from "@k2b/cloud/ai";
import { AiChatActionsProvider, createAiChatTimeline } from "@k2b/cloud/ai/ui";
import { navigateTo } from "@k2b/ssr/nav";
import { dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Button, Chat, MarkdownView, NoticeCard, Placeholder, prompts, renderSafeMarkdown, StatusBadge, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { formatAssistantTaskSchedule, occurrencePresentation, openAssistantTask } from "./AssistantTasksDialog";
import { type AssistantLiveHub, AssistantLiveProvider, matchesAssistantInvalidation, useAssistantLive } from "./assistant-live";
import { assistantConversationHref } from "./assistant-navigation";
import { assistantBrowserText, useAssistantText } from "./ui-copy";

export type AssistantActivity = { task: AiChatTaskView; occurrence: AiChatTaskOccurrenceView; chatTitle: string | null; unread: boolean };
type ActivitiesPage = { items: AssistantActivity[]; hasMore: boolean };
type RunDetail = { task: AiChatTaskView; occurrence: AiChatTaskOccurrenceView; messages: AiStoredMessage[] };

async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/ai/tasks/${path}`, { signal });
  if (!response.ok) throw new Error(assistantBrowserText("Could not load background activity"));
  return response.json();
}

const runStatus = (state: AiChatTaskOccurrenceView["state"], text: (value: string) => string) =>
  state === "completed" ? { label: text("Finished"), tone: "neutral" as const } : occurrencePresentation(state, text);

function RunTranscript(props: { messages: AiStoredMessage[] }) {
  const items = createAiChatTimeline({ messages: () => props.messages, activeTurn: () => null });
  return <Chat.Timeline class="assistant-activity-transcript" items={items()} />;
}

function RunMetadata(props: { task: AiChatTaskView; occurrence: AiChatTaskOccurrenceView }) {
  const locale = useLocale();
  return (
    <span>
      {dates.formatTimeSpan(props.occurrence.scheduledFor, { locale: locale() })} ·{" "}
      {dates.formatDateTime(props.occurrence.scheduledFor, { locale: locale(), timeZone: props.task.timezone })} ·{" "}
      {formatAssistantTaskSchedule(props.task, locale())}
    </span>
  );
}

function AssistantTaskRun(props: { taskId: string; occurrenceId: string; transcript?: boolean }) {
  const text = useAssistantText();
  const detail = query.create({
    source: () => `${props.taskId}/occurrences/${props.occurrenceId}`,
    load: (path, { abortSignal }) => read<RunDetail>(path, abortSignal),
  });
  const live = useAssistantLive();
  onCleanup(
    live.register({
      matches: matchesAssistantInvalidation(["conversation-tasks"]),
      invalidate: async () => {
        await detail.refresh();
      },
    }),
  );
  const instruction = createMemo(() => {
    const value = detail.data();
    const entry = value?.messages.find((item) => item.message.role === "user");
    const content =
      entry?.message.role === "user"
        ? entry.message.content
            .map((part) => (typeof part === "string" ? part : part.type === "text" ? part.text : ""))
            .filter(Boolean)
            .join("\n")
        : "";
    return content.replace(/^Scheduled task [^\n]+:\s*\n/u, "").trim() || value?.task.prompt || "";
  });
  return (
    <div class="assistant-activity-dialog">
      <div class="assistant-activity-dialog__body">
        <Show
          when={detail.data()}
          fallback={
            <Placeholder
              state={detail.error() ? "error" : "loading"}
              title={text(detail.error() ? "Could not load background activity" : "Loading background activity")}
            />
          }
        >
          {(value) => (
            <Show
              when={!props.transcript}
              fallback={
                <AiChatActionsProvider actions={{}}>
                  <RunTranscript messages={value().messages} />
                </AiChatActionsProvider>
              }
            >
              <NoticeCard tone="neutral" title={text("Task instructions")} detail={instruction()} />
              <div class="assistant-activity-result">
                <Show
                  when={value().occurrence.resultText}
                  fallback={
                    <Placeholder
                      state={value().occurrence.error ? "error" : "loading"}
                      title={text(value().occurrence.error ? "Run needs attention" : "The result will appear here and in the chat.")}
                      description={value().occurrence.error ?? undefined}
                    />
                  }
                >
                  {(result) => <MarkdownView markdown={result()} headingScale="compact" />}
                </Show>
              </div>
              <div class="assistant-activity-meta">
                <StatusBadge {...runStatus(value().occurrence.state, text)} variant="chip" />
                <RunMetadata task={value().task} occurrence={value().occurrence} />
              </div>
            </Show>
          )}
        </Show>
      </div>
      <Show when={detail.data()}>
        {(value) => (
          <div class="assistant-activity-dialog__actions">
            <Show when={!props.transcript}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void prompts.dialog(
                    () => (
                      <AssistantLiveProvider value={live}>
                        <AssistantTaskRun taskId={props.taskId} occurrenceId={props.occurrenceId} transcript />
                      </AssistantLiveProvider>
                    ),
                    { title: text("Run history"), icon: "ti ti-messages", size: "large" },
                  )
                }
              >
                {text("Run history")}
              </Button>
            </Show>
            <Button variant="ghost" size="sm" onClick={() => navigateTo(assistantConversationHref("/app/assistant", value().task.chatId))}>
              {text("Open chat")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => openAssistantTask(value().task)}>
              {text("Manage task")}
            </Button>
          </div>
        )}
      </Show>
    </div>
  );
}

function resultPreview(value: string) {
  const element = document.createElement("div");
  element.innerHTML = renderSafeMarkdown(value, { allowImages: false }).replace(/<\/(p|li|h[1-6])>|<br\s*\/?>/gu, " ");
  return element.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

export const openAssistantTaskRun = (taskId: string, occurrenceId: string, live: AssistantLiveHub) =>
  prompts.dialog(
    () => (
      <AssistantLiveProvider value={live}>
        <AssistantTaskRun taskId={taskId} occurrenceId={occurrenceId} />
      </AssistantLiveProvider>
    ),
    {
      title: assistantBrowserText("Background run"),
      icon: "ti ti-calendar-time",
      size: "large",
    },
  );

export function AssistantActivitiesView() {
  const text = useAssistantText();
  const locale = useLocale();
  const [offset, setOffset] = createSignal(0);
  const activities = query.create({
    source: offset,
    load: (page, { abortSignal }) => read<ActivitiesPage>(`activities?limit=50&offset=${page}`, abortSignal),
  });
  const live = useAssistantLive();
  onCleanup(
    live.register({
      matches: matchesAssistantInvalidation(["conversation-tasks"]),
      invalidate: async () => {
        await activities.refresh();
      },
    }),
  );
  return (
    <div class="assistant-activity-dialog">
      <div class="assistant-activity-dialog__body">
        <Show
          when={activities.data()}
          fallback={
            <Placeholder
              state={activities.error() ? "error" : "loading"}
              title={text(activities.error() ? "Could not load background activity" : "Loading background activity")}
            />
          }
        >
          {(page) => (
            <>
              <Show when={page().items.length} fallback={<Placeholder title={text("No background activity yet")} />}>
                <For each={page().items}>
                  {(item) => (
                    <Button
                      variant="ghost"
                      wrap
                      class="assistant-task-row assistant-activity-row"
                      onClick={() => void openAssistantTaskRun(item.task.id, item.occurrence.id, live)}
                    >
                      <span class="assistant-activity-row__content">
                        <span class="assistant-activity-row__heading">
                          <span class="assistant-activity-row__title">{item.task.prompt.split(/\n|:\s/u)[0]}</span>
                          <Show when={item.unread}>
                            <span class="assistant-activity-unread" role="img" aria-label={text("New")} />
                          </Show>
                          <StatusBadge {...runStatus(item.occurrence.state, text)} variant="text" />
                        </span>
                        <span class="assistant-activity-row__preview">
                          {resultPreview(item.occurrence.resultText || item.occurrence.error || "")}
                        </span>
                        <span class="assistant-activity-row__meta">
                          {dates.formatTimeSpan(item.occurrence.scheduledFor, { locale: locale() })} ·{" "}
                          {formatAssistantTaskSchedule(item.task, locale())}
                        </span>
                      </span>
                    </Button>
                  )}
                </For>
              </Show>
              <div class="flex justify-end gap-2">
                <Show when={offset() > 0}>
                  <Button variant="secondary" size="sm" onClick={() => setOffset((value) => Math.max(0, value - 50))}>
                    {text("Previous")}
                  </Button>
                </Show>
                <Show when={page().hasMore}>
                  <Button variant="secondary" size="sm" onClick={() => setOffset((value) => value + 50)}>
                    {text("Next")}
                  </Button>
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

export const openAssistantActivities = (live: AssistantLiveHub) =>
  prompts.dialog(
    () => (
      <AssistantLiveProvider value={live}>
        <AssistantActivitiesView />
      </AssistantLiveProvider>
    ),
    {
      title: assistantBrowserText("Background activity"),
      icon: "ti ti-inbox",
      size: "large",
    },
  );
