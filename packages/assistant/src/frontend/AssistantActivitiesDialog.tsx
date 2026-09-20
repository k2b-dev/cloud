import { navigateTo } from "@k2b/ssr/nav";
import { assistantConversationHref } from "./assistant-navigation";
import { dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Button, MarkdownView, Placeholder, prompts, StatusBadge, useLocale } from "@k2b/ui";
import type { AiChatTaskView, AiChatTaskOccurrenceView, AiStoredMessage } from "@k2b/cloud/ai";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { AssistantLiveProvider, type AssistantLiveHub, matchesAssistantInvalidation, useAssistantLive } from "./assistant-live";
import { assistantBrowserText, useAssistantText } from "./ui-copy";
import { AssistantTasksView, occurrencePresentation } from "./AssistantTasksDialog";

export type AssistantActivity = { task: AiChatTaskView; occurrence: AiChatTaskOccurrenceView; chatTitle: string | null; unread: boolean };
type ActivitiesPage = { items: AssistantActivity[]; hasMore: boolean };
type RunDetail = { task: AiChatTaskView; occurrence: AiChatTaskOccurrenceView; messages: AiStoredMessage[] };

async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/ai/tasks/${path}`, { signal });
  if (!response.ok) throw new Error(assistantBrowserText("Could not load background activity"));
  return response.json();
}

function AssistantTaskRun(props: { taskId: string; occurrenceId: string }) {
  const text = useAssistantText();
  const locale = useLocale();
  const detail = query.create({ source: () => `${props.taskId}/occurrences/${props.occurrenceId}`, load: (path, { abortSignal }) => read<RunDetail>(path, abortSignal) });
  const live = useAssistantLive();
  onCleanup(live.register({ matches: matchesAssistantInvalidation(["conversation-tasks"]), invalidate: async () => { await detail.refresh(); } }));
  return <Show when={detail.data()} fallback={<Placeholder state={detail.error() ? "error" : "loading"} title={text(detail.error() ? "Could not load background activity" : "Loading background activity")} />}>
    {value => <div class="flex flex-col gap-4">
      <p class="text-secondary">{(() => {
        const entry = value().messages.find(item => item.message.role === "user");
        return entry?.message.role === "user"
          ? entry.message.content.map(part => typeof part === "string" ? part : part.type === "text" ? part.text : "").filter(Boolean).join("\n") || value().task.prompt
          : value().task.prompt;
      })()}</p>
      <div class="flex items-center justify-between gap-3 text-sm text-secondary">
        <span>{dates.formatDateTime(value().occurrence.scheduledFor, { locale: locale(), timeZone: value().task.timezone })}</span>
        <StatusBadge {...occurrencePresentation(value().occurrence.state, text)} variant="text" />
      </div>
      <Show when={value().occurrence.resultText}>{result => <MarkdownView markdown={result()} headingScale="compact" />}</Show>
      <Show when={!value().occurrence.resultText && value().occurrence.error}>{error => <Placeholder state="error" title={text("Run needs attention")} description={error()} />}</Show>
      <details><summary class="cursor-pointer text-sm text-secondary">{text("Run history")}</summary>
        <div class="mt-3 flex flex-col gap-4"><For each={value().messages}>{entry => <div class="min-w-0">
          <p class="mb-1 text-xs text-dimmed">{entry.message.role}</p>
          <For each={"content" in entry.message ? entry.message.content : []}>{block => <Show when={typeof block === "string" ? block : block.type === "text" ? block.text : null}>{content => <MarkdownView markdown={content()} headingScale="compact" />}</Show>}</For>
          <details><summary class="cursor-pointer text-xs text-secondary">{text("Details")}</summary><pre class="overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(entry.message, null, 2)}</pre></details>
        </div>}</For></div>
      </details>
      <div class="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={() => navigateTo(assistantConversationHref("/app/assistant", value().task.chatId))}>{text("Open chat")}</Button>
        <Button variant="secondary" onClick={() => void prompts.dialog(() => <AssistantLiveProvider value={live}><AssistantTasksView chatId={value().task.chatId} onOpenRun={(taskId, occurrenceId) => void openAssistantTaskRun(taskId, occurrenceId, live)} /></AssistantLiveProvider>, { title: text("Scheduled tasks"), icon: "ti ti-calendar-time", size: "large" })}>{text("Manage task")}</Button>
      </div>
    </div>}
  </Show>;
}

export const openAssistantTaskRun = (taskId: string, occurrenceId: string, live: AssistantLiveHub) => prompts.dialog(() => <AssistantLiveProvider value={live}><AssistantTaskRun taskId={taskId} occurrenceId={occurrenceId} /></AssistantLiveProvider>, {
  title: assistantBrowserText("Background run"), icon: "ti ti-calendar-time", size: "large",
});

export function AssistantActivitiesView() {
  const text = useAssistantText();
  const locale = useLocale();
  const [offset, setOffset] = createSignal(0);
  const activities = query.create({ source: offset, load: (page, { abortSignal }) => read<ActivitiesPage>(`activities?limit=50&offset=${page}`, abortSignal) });
  const live = useAssistantLive();
  onCleanup(live.register({ matches: matchesAssistantInvalidation(["conversation-tasks"]), invalidate: async () => { await activities.refresh(); } }));
  return <div class="flex flex-col gap-4">
    <Show when={activities.data()} fallback={<Placeholder state={activities.error() ? "error" : "loading"} title={text(activities.error() ? "Could not load background activity" : "Loading background activity")} />}>
      {page => <>
        <Show when={page().items.length} fallback={<Placeholder title={text("No background activity yet")} />}>
          <For each={page().items}>{item => <Button variant="ghost" wrap class="w-full !justify-start text-left [&>.k2b-button__label]:w-full" onClick={() => void openAssistantTaskRun(item.task.id, item.occurrence.id, live)}><span class="flex w-full min-w-0 flex-col gap-2 py-1 text-left">
            <span class="flex w-full items-center justify-between gap-3"><span class="min-w-0 truncate font-medium">{item.chatTitle || text("Chat")}<Show when={item.unread}><span class="ml-2 text-xs text-link">{text("New")}</span></Show></span><StatusBadge {...occurrencePresentation(item.occurrence.state, text)} variant="text" /></span>
            <span class="line-clamp-2 text-sm text-secondary">{item.occurrence.resultText || item.occurrence.error || item.task.prompt}</span>
            <time class="text-xs text-dimmed">{dates.formatDateTime(item.occurrence.scheduledFor, { locale: locale(), timeZone: item.task.timezone })}</time>
          </span></Button>}</For>
        </Show>
        <div class="flex justify-end gap-2">
          <Show when={offset() > 0}><Button variant="secondary" size="sm" onClick={() => setOffset(value => Math.max(0, value - 50))}>{text("Previous")}</Button></Show>
          <Show when={page().hasMore}><Button variant="secondary" size="sm" onClick={() => setOffset(value => value + 50)}>{text("Next")}</Button></Show>
        </div>
      </>}
    </Show>
  </div>;
}

export const openAssistantActivities = (live: AssistantLiveHub) => prompts.dialog(() => <AssistantLiveProvider value={live}><AssistantActivitiesView /></AssistantLiveProvider>, {
  title: assistantBrowserText("Background activity"), icon: "ti ti-inbox", size: "large",
});
