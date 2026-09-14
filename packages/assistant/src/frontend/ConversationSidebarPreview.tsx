import { Button, DescriptionList, InlineGuidance, StatusBadge } from "@k2b/ui";
import type { AiConversation, AiProject } from "@k2b/cloud/ai";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { assistantApi } from "../api/client";
import type { AssistantSidebarPreview } from "../sidebar-preview";
import { useAssistantText } from "./ui-copy";

export function ConversationSidebarPreview(props: { conversation: AiConversation; project?: AiProject; open: boolean; edit: () => void }) {
  const text = useAssistantText();
  const [details, setDetails] = createSignal<AssistantSidebarPreview>();
  const [error, setError] = createSignal(false);
  createEffect(() => {
    if (!props.open) return;
    const controller = new AbortController();
    setError(false);
    void assistantApi
      .loadSidebarPreview(props.conversation.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setDetails(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    onCleanup(() => controller.abort());
  });
  const term = (icon: string, label: string) => (
    <span class="inline-flex items-center gap-2">
      <i class={icon} aria-hidden="true" />
      {label}
    </span>
  );
  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1">
        <strong>{props.conversation.title}</strong>
        <Show when={props.conversation.description}>
          <p class="assistant-sidebar-preview-description">{props.conversation.description}</p>
        </Show>
      </div>
      <DescriptionList
        layout="compact"
        size="sm"
        items={[
          { term: term("ti ti-folder", text("Project")), description: props.project?.name ?? text("No Project") },
          ...(details() ? [{ term: term("ti ti-brain", text("Model")), description: details()!.model ?? text("Not used yet") }] : []),
        ]}
      />
      <Show when={error()}>
        <InlineGuidance tone="danger">{text("Could not load chat details.")}</InlineGuidance>
      </Show>
      <Show when={!details() && !error()}>
        <InlineGuidance loading>{text("Loading details…")}</InlineGuidance>
      </Show>
      <Show when={details()}>
        {(value) => (
          <>
            <Show when={value().apps.length > 0}>
              <div class="flex flex-col gap-1">
                <span class="text-xs text-dimmed">{text("Apps")}</span>
                <For each={value().apps}>
                  {(app) => (
                    <a class="assistant-sidebar-preview-resource inline-flex items-center gap-2" href={`/app/assistant/apps/${encodeURIComponent(app.id)}`}>
                      <i class={app.icon || "ti ti-app-window"} aria-hidden="true" />
                      {app.title}
                    </a>
                  )}
                </For>
              </div>
            </Show>
            <Show when={value().files.length > 0}>
              <div class="flex flex-col gap-1">
                <span class="text-xs text-dimmed">{text("Files")}</span>
                <For each={value().files.slice(0, 5)}>
                  {(file) => (
                    <span class="assistant-sidebar-preview-resource inline-flex items-center gap-2" title={file.path}>
                      <i class="ti ti-file" aria-hidden="true" />
                      <span class="truncate">{file.path.split("/").pop()}</span>
                    </span>
                  )}
                </For>
                <Show when={value().files.length > 5}>
                  <span class="text-xs text-dimmed">+{value().files.length - 5}</span>
                </Show>
              </div>
            </Show>
            <Show when={value().hasMoreSources}>
              <span class="text-xs text-dimmed">{text("More resources in the chat.")}</span>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.conversation.doneAt}>
        <StatusBadge tone="ok" label={text("Done")} />
      </Show>
      <Button size="sm" variant="secondary" class="self-start" onClick={props.edit}>
        <i class="ti ti-settings" aria-hidden="true" />
        {text("Chat settings")}
      </Button>
    </div>
  );
}
