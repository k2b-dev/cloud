import { query } from "@k2b/stdlib/solid";
import { Button, Lightbox, Placeholder, prompts, StatusBadge } from "@k2b/ui";
import type { AiConversationSource, AiProject, AiChatTaskView as AssistantChatTask } from "@valentinkolb/cloud/ai";
import { conversationFileSource } from "@valentinkolb/cloud/ai/solid";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { assistantApi } from "../api/client";
import type { AssistantChatContextSnapshot } from "../chat-context";
import type { AssistantProjectContextSnapshot } from "../project-context";
import { AssistantChatContextSurface } from "./AssistantChatContextSurfaces";
import {
  type AssistantContextFile,
  AssistantContextRow,
  AssistantContextRows,
  AssistantContextSection,
  AssistantContextViewAll,
  assistantContextCountTitle,
  assistantProjectFileSource,
  confirmOpenAssistantLink,
  isAssistantContextImage,
  loadAssistantContextImages,
  openAssistantCloudReference,
  openAssistantContextFiles,
  openAssistantKnowledgeSearch,
  openAssistantMarkdown,
} from "./AssistantContextContent";
import { AssistantTasksView, formatAssistantTaskSchedule } from "./AssistantTasksDialog";
import {
  assistantChatContextFor,
  assistantReferenceTitle,
  assistantResourceTypeLabel,
  splitAssistantConversationSources,
} from "./assistant-context";
import {
  type AssistantLiveHub,
  type AssistantLiveInvalidation,
  AssistantLiveProvider,
  matchesAssistantInvalidation,
  useAssistantLive,
} from "./assistant-live";

export { splitAssistantConversationSources } from "./assistant-context";

const CONTEXT_PREVIEW_LIMIT = 3;

export const assistantChatContextHasContent = (snapshot: AssistantChatContextSnapshot): boolean =>
  snapshot.sources.some((source) => source.kind !== "file") ||
  snapshot.files.length > 0 ||
  snapshot.tasks.some((task) => task.state !== "completed");

export const assistantChatContextHasPanel = (snapshot: AssistantChatContextSnapshot, hasProject = false): boolean =>
  hasProject || assistantChatContextHasContent(snapshot);

const taskStatus = (task: AssistantChatTask) => {
  if (task.state === "active") return { label: task.schedule.kind === "once" ? "Pending" : "Active", tone: "ok" as const };
  if (task.state === "paused") return { label: "Paused", tone: "neutral" as const };
  return { label: "Needs attention", tone: "warning" as const };
};

const openSourceSearch = async (title: string, sources: readonly AiConversationSource[]) => {
  const selected = await prompts.search<AiConversationSource>(
    ({ query }) => {
      const normalized = query.trim().toLocaleLowerCase();
      return sources
        .filter((source) => !normalized || `${source.title} ${source.preview ?? ""}`.toLocaleLowerCase().includes(normalized))
        .map((source) => ({ value: source, label: source.title, desc: source.preview ?? undefined, icon: source.icon }));
    },
    { title, icon: "ti ti-search", placeholder: `Search ${title.toLocaleLowerCase()}…`, minQueryLength: 0, size: "small" },
  );
  if (selected?.value?.href) await confirmOpenAssistantLink(selected.value.title, selected.value.href);
};

type AssistantChatContextQueryProps = {
  chatId: string;
  project?: AiProject | null;
  initial?: AssistantChatContextSnapshot | null;
};

const createAssistantChatContextState = (props: AssistantChatContextQueryProps) => {
  const live = useAssistantLive();
  const snapshot = query.create<string, AssistantChatContextSnapshot, AssistantLiveInvalidation>({
    source: () => props.chatId,
    initial: props.initial ? { source: props.initial.chatId, data: props.initial } : undefined,
    load: (chatId, { abortSignal }) => assistantApi.loadChatContext(chatId, abortSignal),
  });
  const projectSnapshot = query.create<string | null, AssistantProjectContextSnapshot | null, AssistantLiveInvalidation>({
    source: () => props.project?.id ?? null,
    load: (projectId, { abortSignal }) => {
      if (!projectId) return Promise.resolve(null);
      return assistantApi.loadProjectContext(projectId, abortSignal);
    },
  });
  const unregisterChat = live.register({
    matches: (invalidation) =>
      matchesAssistantInvalidation(["conversation-sources", "conversation-files", "conversation-tasks", "conversation-detail"])(
        invalidation,
      ) &&
      (!invalidation.conversationIds || invalidation.conversationIds.has(props.chatId)),
    invalidate: (invalidation) => snapshot.invalidate(invalidation),
  });
  const unregisterProject = live.register({
    matches: (invalidation) =>
      Boolean(props.project?.id) &&
      matchesAssistantInvalidation(["project-detail", "project-context"], { projectId: props.project!.id })(invalidation),
    invalidate: (invalidation) => projectSnapshot.invalidate(invalidation),
  });
  onCleanup(() => {
    unregisterChat();
    unregisterProject();
  });
  const value = () => assistantChatContextFor(props.chatId, snapshot.data());
  const context = () => {
    const chat = value();
    if (!chat || (props.project && !projectSnapshot.data())) return null;
    const sources = splitAssistantConversationSources(chat.sources);
    return {
      chat: { ...chat, ...sources, tasks: chat.tasks.filter((task) => task.state !== "completed") },
      project: props.project ?? null,
      projectContext: projectSnapshot.data() ?? null,
    };
  };
  return {
    snapshot: value,
    context,
    error: () => snapshot.error() ?? projectSnapshot.error(),
    refresh: async () => {
      await Promise.all([snapshot.refresh(), props.project ? projectSnapshot.refresh() : Promise.resolve()]);
    },
    presence: () => {
      const chat = value();
      if (!chat) return props.project ? true : null;
      return assistantChatContextHasPanel(chat, Boolean(props.project));
    },
  };
};

type AssistantChatContextState = ReturnType<typeof createAssistantChatContextState>;

function AssistantChatContextView(props: { state: AssistantChatContextState }) {
  const [lightbox, setLightbox] = createSignal<{ images: Awaited<ReturnType<typeof loadAssistantContextImages>>; index: number } | null>(
    null,
  );
  return (
    <Show
      when={props.state.context()}
      fallback={
        <Placeholder
          state={props.state.error() ? "error" : "loading"}
          title={props.state.error() ? "Could not load context" : "Loading context"}
          description={props.state.error()?.message}
          action={
            props.state.error() ? (
              <Button size="sm" variant="secondary" onClick={() => void props.state.refresh()}>
                Retry
              </Button>
            ) : undefined
          }
        />
      }
    >
      {(value) => {
        const chatSource = conversationFileSource("/api/ai", value().chat.chatId);
        const projectSource = value().project
          ? assistantProjectFileSource(value().project!.id, () => value().projectContext?.files ?? [])
          : null;
        const files = (): AssistantContextFile[] => [
          ...value().chat.files.map((file) => ({
            id: `chat:${file.path}`,
            path: file.path,
            mediaType: file.mediaType,
            size: file.size,
            scope: "chat" as const,
            source: chatSource,
          })),
          ...(value().projectContext?.files ?? []).map((file) => ({
            id: `project:${file.id}`,
            path: file.path,
            mediaType: file.mediaType,
            size: file.size,
            scope: "project" as const,
            source: projectSource!,
          })),
        ];
        const images = () => files().filter(isAssistantContextImage);
        const regularFiles = () => files().filter((file) => !isAssistantContextImage(file));
        const hasMixedScope = (items: readonly AssistantContextFile[]) =>
          items.some((file) => file.scope === "chat") && items.some((file) => file.scope === "project");
        const openImages = async (selected?: AssistantContextFile) => {
          try {
            const loaded = await loadAssistantContextImages(files());
            const index = selected
              ? Math.max(
                  0,
                  loaded.findIndex((entry) => entry.file.id === selected.id),
                )
              : 0;
            setLightbox({ images: loaded, index });
          } catch (error) {
            void prompts.error(error instanceof Error ? error.message : "Images could not be loaded.", { title: "Could not open images" });
          }
        };
        const references = () => [
          ...value().chat.references.map((source) => ({
            kind: "source" as const,
            title: assistantReferenceTitle(source),
            description: source.ref ? assistantResourceTypeLabel(source.ref) : "Cloud resource",
            searchText: source.preview ?? "",
            icon: source.icon,
            source,
          })),
          ...(value().projectContext?.references ?? []).map((reference) => ({
            kind: "project" as const,
            title: reference.label || `${reference.ref.type} · ${reference.ref.id}`,
            description: assistantResourceTypeLabel(reference.ref),
            searchText: "Project",
            icon: "ti ti-link",
            reference,
          })),
        ];
        const openReferences = async () => {
          const items = references();
          const selected = await prompts.search<(typeof items)[number]>(
            ({ query }) => {
              const normalized = query.trim().toLocaleLowerCase();
              return items
                .filter(
                  (reference) =>
                    !normalized ||
                    `${reference.title} ${reference.description ?? ""} ${reference.searchText}`.toLocaleLowerCase().includes(normalized),
                )
                .map((reference) => ({
                  value: reference,
                  label: reference.title,
                  desc: reference.description,
                  icon: reference.icon,
                }));
            },
            { title: "References", icon: "ti ti-link", placeholder: "Search references…", minQueryLength: 0, size: "small" },
          );
          if (!selected?.value) return;
          if (selected.value.kind === "source" && selected.value.source.href) {
            await confirmOpenAssistantLink(selected.value.title, selected.value.source.href);
          } else if (selected.value.kind === "project") {
            await openAssistantCloudReference(selected.value.title, selected.value.reference.ref);
          }
        };
        return (
          <div class="flex flex-col gap-5">
            <Show when={value().project}>
              {(project) => (
                <AssistantContextSection title={project().name} identity>
                  <AssistantContextRow
                    icon="ti ti-eye"
                    title="View project"
                    onClick={() =>
                      void openAssistantMarkdown(
                        "Project instructions",
                        project().instructions || "No Project instructions yet.",
                        "ti ti-adjustments-horizontal",
                      )
                    }
                  />
                </AssistantContextSection>
              )}
            </Show>

            <Show when={value().projectContext}>
              {(project) => (
                <Show when={project().knowledge[0]}>
                  {(item) => (
                    <AssistantContextSection title="Project knowledge">
                      <AssistantContextRows>
                        <AssistantContextRow
                          icon="ti ti-bulb"
                          title={item().title}
                          onClick={() => void openAssistantMarkdown(item().title, item().content, "ti ti-bulb")}
                        />
                        <Show when={project().knowledge.length > 1}>
                          <AssistantContextViewAll onClick={() => void openAssistantKnowledgeSearch(project().knowledge)} />
                        </Show>
                      </AssistantContextRows>
                    </AssistantContextSection>
                  )}
                </Show>
              )}
            </Show>

            <Show when={value().chat.sources.length > 0}>
              <AssistantContextSection title="Sources">
                <AssistantContextRows>
                  <For each={value().chat.sources.slice(0, CONTEXT_PREVIEW_LIMIT)}>
                    {(source) => (
                      <AssistantContextRow
                        icon={source.icon}
                        title={source.title}
                        description={source.preview ?? undefined}
                        onClick={source.href ? () => void confirmOpenAssistantLink(source.title, source.href!) : undefined}
                      />
                    )}
                  </For>
                  <Show when={value().chat.sources.length > CONTEXT_PREVIEW_LIMIT}>
                    <AssistantContextViewAll onClick={() => void openSourceSearch("Sources", value().chat.sources)} />
                  </Show>
                </AssistantContextRows>
              </AssistantContextSection>
            </Show>

            <Show when={references().length > 0}>
              <AssistantContextSection title={assistantContextCountTitle(references().length, "Reference", "References")}>
                <AssistantContextRows>
                  <For each={references().slice(0, CONTEXT_PREVIEW_LIMIT)}>
                    {(reference) => (
                      <AssistantContextRow
                        icon={reference.icon}
                        title={reference.title}
                        description={reference.description}
                        scope={reference.kind === "project" ? "project" : undefined}
                        showScope={reference.kind === "project" && value().chat.references.length > 0}
                        onClick={
                          reference.kind === "project"
                            ? () => void openAssistantCloudReference(reference.title, reference.reference.ref)
                            : reference.source.href
                              ? () => void confirmOpenAssistantLink(reference.title, reference.source.href!)
                              : reference.source.ref
                                ? () => void openAssistantCloudReference(reference.title, reference.source.ref!)
                                : undefined
                        }
                      />
                    )}
                  </For>
                  <Show when={references().length > CONTEXT_PREVIEW_LIMIT}>
                    <AssistantContextViewAll onClick={() => void openReferences()} />
                  </Show>
                </AssistantContextRows>
              </AssistantContextSection>
            </Show>

            <Show when={images().length > 0}>
              <AssistantContextSection title={assistantContextCountTitle(images().length, "Image", "Images")}>
                <AssistantContextRows>
                  <For each={images().slice(0, CONTEXT_PREVIEW_LIMIT)}>
                    {(file) => (
                      <AssistantContextRow
                        icon="ti ti-photo"
                        title={file.path.replace(/^.*\//u, "")}
                        scope={file.scope}
                        showScope={hasMixedScope(images())}
                        onClick={() => void openImages(file)}
                      />
                    )}
                  </For>
                  <Show when={images().length > CONTEXT_PREVIEW_LIMIT}>
                    <AssistantContextViewAll onClick={() => void openImages()} />
                  </Show>
                </AssistantContextRows>
              </AssistantContextSection>
            </Show>

            <Show when={regularFiles().length > 0}>
              <AssistantContextSection title={assistantContextCountTitle(regularFiles().length, "File", "Files")}>
                <AssistantContextRows>
                  <For each={regularFiles().slice(0, CONTEXT_PREVIEW_LIMIT)}>
                    {(file) => (
                      <AssistantContextRow
                        icon="ti ti-file"
                        title={file.path.replace(/^.*\//u, "")}
                        scope={file.scope}
                        showScope={hasMixedScope(regularFiles())}
                        onClick={() => void openAssistantContextFiles(regularFiles(), file)}
                      />
                    )}
                  </For>
                  <Show when={regularFiles().length > CONTEXT_PREVIEW_LIMIT}>
                    <AssistantContextViewAll onClick={() => void openAssistantContextFiles(regularFiles())} />
                  </Show>
                </AssistantContextRows>
              </AssistantContextSection>
            </Show>

            <Show when={value().chat.tasks[0]}>
              {(task) => {
                const status = () => taskStatus(task());
                return (
                  <AssistantContextSection title="Scheduled">
                    <AssistantContextRows>
                      <div class="flex items-start justify-between gap-2">
                        <span class="min-w-0">
                          <span class="block line-clamp-2 text-xs text-secondary">{task().prompt}</span>
                          <span class="mt-1 block truncate text-xs text-dimmed">{formatAssistantTaskSchedule(task())}</span>
                        </span>
                        <StatusBadge label={status().label} tone={status().tone} variant="text" />
                      </div>
                      <Show when={value().chat.tasks.length > 1}>
                        <AssistantContextViewAll
                          onClick={() =>
                            void prompts.dialog<void>(() => <AssistantTasksView chatId={value().chat.chatId} />, {
                              title: "Scheduled tasks",
                              icon: "ti ti-calendar-time",
                              size: "large",
                            })
                          }
                        />
                      </Show>
                    </AssistantContextRows>
                  </AssistantContextSection>
                );
              }}
            </Show>
            <Show when={lightbox()}>
              {(state) => (
                <Lightbox
                  images={state().images.map((entry) => entry.image)}
                  initialIndex={state().index}
                  onClose={() => setLightbox(null)}
                />
              )}
            </Show>
          </div>
        );
      }}
    </Show>
  );
}

export function AssistantChatContextContent(props: {
  chatId: string;
  project?: AiProject | null;
  initial?: AssistantChatContextSnapshot | null;
  onPresenceChange?: (hasContent: boolean | null) => void;
  onSnapshotChange?: (snapshot: AssistantChatContextSnapshot | null) => void;
}) {
  const state = createAssistantChatContextState(props);
  createEffect(() => {
    props.onPresenceChange?.(state.presence());
    props.onSnapshotChange?.(state.snapshot() ?? null);
  });
  return <AssistantChatContextView state={state} />;
}

export function AssistantChatContextPanel(props: {
  chatId: string;
  project?: AiProject | null;
  initial?: AssistantChatContextSnapshot | null;
  onPresenceChange?: (hasContent: boolean | null) => void;
  onSnapshotChange?: (snapshot: AssistantChatContextSnapshot | null) => void;
}) {
  const state = createAssistantChatContextState(props);
  createEffect(() => {
    props.onPresenceChange?.(state.presence());
    props.onSnapshotChange?.(state.snapshot() ?? null);
  });
  return (
    <Show when={state.presence() === true}>
      <AssistantChatContextSurface>
        <AssistantChatContextView state={state} />
      </AssistantChatContextSurface>
    </Show>
  );
}

export const openAssistantChatContextDialog = (chatId: string, project: AiProject | null, live: AssistantLiveHub) =>
  prompts.dialog<void>(
    () => (
      <AssistantLiveProvider value={live}>
        <AssistantChatContextContent chatId={chatId} project={project} />
      </AssistantLiveProvider>
    ),
    { title: "Chat context", icon: "ti ti-adjustments-horizontal", size: "medium" },
  );
