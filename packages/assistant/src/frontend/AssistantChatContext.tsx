import { ContextStudio } from "../artifacts/ContextStudio";
import { formatDictationTimestamp } from "./dictation-files";
import { query } from "@k2b/stdlib/solid";
import { useLocale, Button, Lightbox, Placeholder, prompts, StatusBadge, FileView, MarkdownView, TextInput } from "@k2b/ui";
import type { JSX } from "solid-js";
import type { AiConversationSource, AiProject, AiChatTaskView as AssistantChatTask } from "@k2b/cloud/ai";
import { conversationFileSource } from "@k2b/cloud/ai/solid";
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
  visibleAssistantReferences,
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
import { assistantBrowserCopy, assistantBrowserText, useAssistantText } from "./ui-copy";

export { splitAssistantConversationSources } from "./assistant-context";

const CONTEXT_PREVIEW_LIMIT = 3;
export type ContextCategory = "apps" | "files" | "sources" | "knowledge" | "tasks";
export type ContextView = { context?: { conversationId: string; category: ContextCategory; project?: AiProject | null }; file?: { conversationId: string; path: string }; key: string; title: string; render: () => JSX.Element };
type ContextNavigation = {
  onOpenView?: (view: ContextView) => void;
  category?: ContextCategory;
};

export const assistantChatContextHasContent = (snapshot: AssistantChatContextSnapshot): boolean =>
  visibleAssistantReferences(snapshot.sources, snapshot.chatId, snapshot.tasks.find((task) => task.state !== "completed")?.id).some((source) => source.kind !== "file") ||
  snapshot.runs.length > 0 ||
  snapshot.files.length > 0 ||
  snapshot.tasks.some((task) => task.state !== "completed");

export const assistantChatContextHasPanel = (snapshot: AssistantChatContextSnapshot, hasProject = false): boolean =>
  hasProject || assistantChatContextHasContent(snapshot);

const taskStatus = (task: AssistantChatTask, text: (value: string) => string) => {
  if (task.state === "active") return { label: text(task.schedule.kind === "once" ? "Pending" : "Active"), tone: "ok" as const };
  if (task.state === "paused") return { label: text("Paused"), tone: "neutral" as const };
  return { label: text("Needs attention"), tone: "warning" as const };
};

const openSourceSearch = async (title: string, sources: readonly AiConversationSource[]) => {
  const selected = await prompts.search<AiConversationSource>(
    ({ query }) => {
      const normalized = query.trim().toLocaleLowerCase();
      return sources
        .filter((source) => !normalized || `${source.title} ${source.preview ?? ""}`.toLocaleLowerCase().includes(normalized))
        .map((source) => ({ value: source, label: source.title, desc: source.preview ?? undefined, icon: source.icon }));
    },
    { title, icon: "ti ti-search", placeholder: assistantBrowserCopy().searchNamed({ name: title }), minQueryLength: 0, size: "small" },
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

function AssistantChatContextView(props: ContextNavigation & { state: AssistantChatContextState; onOpenApp?: (id: string, title: string, start?: boolean) => void }) {
  const locale = useLocale();
  const text = useAssistantText();
  const [search, setSearch] = createSignal("");
  const includes = (title: string) => !props.category || title.toLocaleLowerCase().includes(search().trim().toLocaleLowerCase());
  const section = (category: ContextCategory) => !props.category || props.category === category;
  const limit = () => props.category ? Infinity : CONTEXT_PREVIEW_LIMIT;
  const openMarkdown = (title: string, markdown: string, icon?: string) => props.onOpenView
    ? props.onOpenView({ key: `${props.state.context()?.chat.chatId}:markdown:${title}`, title, render: () => <MarkdownView markdown={markdown} headingScale="compact" /> })
    : openAssistantMarkdown(title, markdown, icon);
  const openFiles = (files: readonly AssistantContextFile[], selected?: AssistantContextFile) => {
    if (!props.onOpenView) return openAssistantContextFiles(files, selected);
    if (!selected) return overview("files", text("Files"));
    const file = selected;
    props.onOpenView({ file: file.scope === "chat" ? { conversationId: props.state.context()!.chat.chatId, path: file.path } : undefined, key: `${props.state.context()!.chat.chatId}:${file.id}`, title: file.displayName ?? file.path.split("/").pop()!, render: () => <FileView previewPreferencesKey="assistant.csv-preview" file={{ path: file.path }} load={() => file.source.read(file.path)} downloadHref={file.source.downloadHref?.(file.path)} /> });
  };
  const overview = (category: ContextCategory, title: string) => {
    const context = props.state.context();
    if (!context || !props.onOpenView) return;
    props.onOpenView({ context: { conversationId: context.chat.chatId, category, project: context.project }, key: `${context.chat.chatId}:${category}`, title,
      render: () => <AssistantChatContextContent chatId={context.chat.chatId} project={context.project} category={category} onOpenView={props.onOpenView} onOpenApp={props.onOpenApp} /> });
  };
  const [lightbox, setLightbox] = createSignal<{ images: Awaited<ReturnType<typeof loadAssistantContextImages>>; index: number } | null>(
    null,
  );
  return (
    <Show
      when={props.state.context()}
      fallback={
        <Placeholder
          state={props.state.error() ? "error" : "loading"}
          title={props.state.error() ? text("Could not load context") : undefined}
          description={props.state.error()?.message}
          action={
            props.state.error() ? (
              <Button size="sm" variant="secondary" onClick={() => void props.state.refresh()}>
                {text("Retry")}
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
            dictationRecordedAt: file.dictationRecordedAt,
            displayName: file.dictationRecordedAt ? formatDictationTimestamp(file.dictationRecordedAt, locale()) : undefined,
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
        const regularFiles = () => files().filter((file) => !file.dictationRecordedAt && !isAssistantContextImage(file));
        const voiceInputs = () => files().filter((file) => file.dictationRecordedAt);
        const hasMixedScope = (items: readonly AssistantContextFile[]) =>
          items.some((file) => file.scope === "chat") && items.some((file) => file.scope === "project");
        const openImages = async (selected?: AssistantContextFile) => {
          if (props.onOpenView) { openFiles(images(), selected); return; }
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
            void prompts.error(error instanceof Error ? error.message : text("Images could not be loaded."), { title: text("Could not open images") });
          }
        };
        const allReferences = () => [
          ...visibleAssistantReferences(value().chat.references, value().chat.chatId, value().chat.tasks[0]?.id).map((source) => ({
            kind: "source" as const,
            title: assistantReferenceTitle(source, text),
            description: source.preview || (source.ref ? assistantResourceTypeLabel(source.ref, text) : text("Cloud resource")),
            searchText: source.preview ?? "",
            icon: source.icon,
            source,
          })),
          ...(value().projectContext?.references ?? []).map((reference) => ({
            kind: "project" as const,
            title: reference.label || `${reference.ref.type} · ${reference.ref.id}`,
            description: assistantResourceTypeLabel(reference.ref, text),
            searchText: text("Project"),
            icon: "ti ti-link",
            reference,
          })),
        ];
        const refOf = (item: ReturnType<typeof allReferences>[number]) => item.kind === "source" ? item.source.ref : item.reference.ref;
        const references = () => allReferences().filter(item => refOf(item)?.type !== "assistant.artifact");
        const apps = () => [...new Map(allReferences().filter(item => refOf(item)?.type === "assistant.artifact").reverse().map(item => [refOf(item)!.id, item])).values()];
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
            { title: text("References"), icon: "ti ti-link", placeholder: text("Search references…"), minQueryLength: 0, size: "small" },
          );
          if (!selected?.value) return;
          if (selected.value.kind === "source" && selected.value.source.href) {
            await confirmOpenAssistantLink(selected.value.title, selected.value.source.href);
          } else if (selected.value.kind === "project") {
            await openAssistantCloudReference(selected.value.title, selected.value.reference.ref);
          }
        };
        return (
          <div class={props.category ? "flex flex-col gap-4" : "flex flex-col gap-3"}>
            <Show when={props.category && props.category !== "tasks"}><TextInput value={search()} onValueChange={setSearch} aria-label={text("Search")} placeholder={text("Search")} /></Show>
            <Show when={props.category && !(props.category === "apps" ? apps().filter(app => includes(app.title)).length + value().chat.runs.length : props.category === "files" ? files().filter(file => includes(file.displayName ?? file.path)).length : props.category === "sources" ? references().filter(item => includes(item.title)).length + value().chat.sources.filter(item => includes(item.title)).length : props.category === "knowledge" ? (value().project ? 1 : 0) + (value().projectContext?.knowledge.length ?? 0) : value().chat.tasks.length)}><p role="status" class="text-sm text-secondary">{text(search() ? "No matching items." : "No items yet.")}</p></Show>
            <Show when={section("knowledge") && value().project}>
              {(project) => (
                <AssistantContextSection title={project().name} identity>
                  <AssistantContextRow
                    icon="ti ti-eye"
                    title={text("View project")}
                    onClick={() =>
                      void openMarkdown(
                        text("Project instructions"),
                        project().instructions || text("No Project instructions yet."),
                        "ti ti-adjustments-horizontal",
                      )
                    }
                  />
                </AssistantContextSection>
              )}
            </Show>

            <Show when={props.category === "knowledge"}><For each={value().projectContext?.knowledge.filter(item => includes(item.title))}>{item => <AssistantContextRow title={item.title} icon="ti ti-bulb" onClick={() => void openMarkdown(item.title, item.content)} />}</For></Show>
            <Show when={!props.category && section("knowledge") && value().projectContext}>
              {(project) => (
                <Show when={project().knowledge[0]}>
                  {(item) => (
                    <AssistantContextSection title={text("Project knowledge")}>
                      <AssistantContextRows>
                        <AssistantContextRow
                          icon="ti ti-bulb"
                          title={item().title}
                          onClick={() => void openMarkdown(item().title, item().content, "ti ti-bulb")}
                        />
                        <Show when={!props.category && project().knowledge.length > 1}>
                          <AssistantContextViewAll onClick={() => props.onOpenView ? overview("knowledge", text("Project knowledge")) : void openAssistantKnowledgeSearch(project().knowledge)} />
                        </Show>
                      </AssistantContextRows>
                    </AssistantContextSection>
                  )}
                </Show>
              )}
            </Show>

            <Show when={section("sources") && value().chat.sources.length > 0}>
              <AssistantContextSection title={text("Sources")}>
                <AssistantContextRows>
                  <For each={value().chat.sources.filter(source => includes(source.title)).slice(0, limit())}>
                    {(source) => (
                      <AssistantContextRow
                        icon={source.icon}
                        title={source.title}
                        description={source.preview ?? undefined}
                        onClick={source.href ? () => void confirmOpenAssistantLink(source.title, source.href!) : undefined}
                      />
                    )}
                  </For>
                  <Show when={!props.category && value().chat.sources.length > CONTEXT_PREVIEW_LIMIT}>
                    <AssistantContextViewAll count={value().chat.sources.length} onClick={() => props.onOpenView ? overview("sources", text("Sources")) : void openSourceSearch(text("Sources"), value().chat.sources)} />
                  </Show>
                </AssistantContextRows>
              </AssistantContextSection>
            </Show>

            <Show when={section("apps") && (apps().length > 0 || value().chat.runs.length > 0)}>
              <AssistantContextSection title={props.category === "apps" ? "" : "Studio"}>
                <Show when={props.category === "apps"} fallback={
                  <AssistantContextRows>
                    <For each={apps().filter(app => includes(app.title)).slice(0, limit())}>{app => <AssistantContextRow
                      icon={app.kind === "source" ? app.source.icon ?? "ti ti-app-window" : "ti ti-app-window"}
                      title={app.title} description={app.kind === "source" ? app.source.preview ?? undefined : undefined}
                      onClick={() => props.onOpenApp ? props.onOpenApp(refOf(app)!.id, app.title) : void openAssistantCloudReference(app.title, refOf(app)!)} />}</For>
                    <Show when={!props.category}><AssistantContextViewAll count={apps().length + value().chat.runCount} onClick={() => overview("apps", "Studio")} /></Show>
                  </AssistantContextRows>
                }>
                  <ContextStudio snapshot={value().chat} projects={value().project ? [value().project!] : []} search={search()} refresh={props.state.refresh} onStart={props.onOpenApp} />
                </Show>
              </AssistantContextSection>
            </Show>

            <Show when={section("sources") && references().length > 0}>
              <AssistantContextSection title={assistantContextCountTitle(references().length, text("Reference"), text("References"))}>
                <AssistantContextRows>
                  <For each={references().filter(item => includes(item.title)).slice(0, limit())}>
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
                  <Show when={!props.category && references().length > CONTEXT_PREVIEW_LIMIT}>
                    <AssistantContextViewAll count={references().length} onClick={() => props.onOpenView ? overview("sources", text("Sources")) : void openReferences()} />
                  </Show>
                </AssistantContextRows>
              </AssistantContextSection>
            </Show>

            <Show when={section("files") && images().length > 0}>
              <AssistantContextSection title={assistantContextCountTitle(images().length, text("Image"), text("Images"))}>
                <AssistantContextRows>
                  <For each={images().filter(file => includes(file.displayName ?? file.path)).slice(0, limit())}>
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
                  <Show when={!props.category && images().length > CONTEXT_PREVIEW_LIMIT}>
                    <AssistantContextViewAll onClick={() => void openImages()} />
                  </Show>
                </AssistantContextRows>
              </AssistantContextSection>
            </Show>

            <Show when={section("files") && voiceInputs().length > 0}>
              <AssistantContextSection title={text("Voice inputs")}>
                <AssistantContextRows>
                  <For each={voiceInputs().filter(file => includes(file.displayName ?? file.path)).slice(0, limit())}>{(file) => (
                    <AssistantContextRow icon="ti ti-microphone" title={file.displayName!}
                      onClick={() => void openFiles(voiceInputs(), file)} />
                  )}</For>
                  <Show when={!props.category && voiceInputs().length > CONTEXT_PREVIEW_LIMIT}>
                    <AssistantContextViewAll count={voiceInputs().length} onClick={() => void openFiles(voiceInputs())} />
                  </Show>
                </AssistantContextRows>
              </AssistantContextSection>
            </Show>

            <Show when={section("files") && regularFiles().length > 0}>
              <AssistantContextSection title={assistantContextCountTitle(regularFiles().length, text("File"), text("Files"))}>
                <AssistantContextRows>
                  <For each={regularFiles().filter(file => includes(file.displayName ?? file.path)).slice(0, limit())}>
                    {(file) => (
                      <AssistantContextRow
                        icon="ti ti-file"
                        title={file.path.replace(/^.*\//u, "")}
                        scope={file.scope}
                        showScope={hasMixedScope(regularFiles())}
                        onClick={() => void openFiles(regularFiles(), file)}
                      />
                    )}
                  </For>
                  <Show when={!props.category && regularFiles().length > CONTEXT_PREVIEW_LIMIT}>
                    <AssistantContextViewAll count={regularFiles().length} onClick={() => void openFiles(regularFiles())} />
                  </Show>
                </AssistantContextRows>
              </AssistantContextSection>
            </Show>

            <Show when={props.category === "tasks"}><AssistantTasksView chatId={value().chat.chatId} /></Show>
            <Show when={!props.category && section("tasks") && value().chat.tasks[0]}>
              {(task) => {
                const status = () => taskStatus(task(), text);
                return (
                  <AssistantContextSection title={text("Scheduled")}>
                    <AssistantContextRows>
                      <AssistantContextRow title={task().prompt} description={formatAssistantTaskSchedule(task(), locale())}
                        onClick={props.onOpenView ? () => overview("tasks", text("Scheduled tasks")) : undefined}
                        trailing={<StatusBadge label={status().label} tone={status().tone} variant="text" />} />
                      <Show when={!props.category && value().chat.tasks.length > 1}>
                        <AssistantContextViewAll
                          onClick={() =>
                            props.onOpenView ? overview("tasks", text("Scheduled tasks")) : void prompts.dialog<void>(() => <AssistantTasksView chatId={value().chat.chatId} />, {
                              title: text("Scheduled tasks"),
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

export function AssistantChatContextContent(props: ContextNavigation & {
  chatId: string;
  project?: AiProject | null;
  initial?: AssistantChatContextSnapshot | null;
  onPresenceChange?: (hasContent: boolean | null) => void;
  onSnapshotChange?: (snapshot: AssistantChatContextSnapshot | null) => void;
  onOpenApp?: (id: string, title: string, start?: boolean) => void;
}) {
  const state = createAssistantChatContextState(props);
  createEffect(() => {
    props.onPresenceChange?.(state.presence());
    props.onSnapshotChange?.(state.snapshot() ?? null);
  });
  return <AssistantChatContextView state={state} onOpenApp={props.onOpenApp} category={props.category} onOpenView={props.onOpenView} />;
}

export function AssistantChatContextPanel(props: ContextNavigation & {
  chatId: string;
  project?: AiProject | null;
  initial?: AssistantChatContextSnapshot | null;
  onPresenceChange?: (hasContent: boolean | null) => void;
  onSnapshotChange?: (snapshot: AssistantChatContextSnapshot | null) => void;
  onOpenApp?: (id: string, title: string, start?: boolean) => void;
}) {
  const state = createAssistantChatContextState(props);
  createEffect(() => {
    props.onPresenceChange?.(state.presence());
    props.onSnapshotChange?.(state.snapshot() ?? null);
  });
  return (
    <Show when={state.presence() === true}>
      <AssistantChatContextSurface>
        <AssistantChatContextView state={state} onOpenApp={props.onOpenApp} category={props.category} onOpenView={props.onOpenView} />
      </AssistantChatContextSurface>
    </Show>
  );
}

export const openAssistantChatContextDialog = (chatId: string, project: AiProject | null, live: AssistantLiveHub, onOpenApp?: (id: string, title: string, start?: boolean) => void, onOpenView?: (view: ContextView) => void) =>
  prompts.dialog<void>(
    (close) => (
      <AssistantLiveProvider value={live}>
        <AssistantChatContextContent chatId={chatId} project={project} onOpenApp={onOpenApp ? (id, title, start) => { onOpenApp(id, title, start); close(); } : undefined} onOpenView={onOpenView ? view => { onOpenView(view); close(); } : undefined} />
      </AssistantLiveProvider>
    ),
    { title: assistantBrowserText("Chat context"), icon: "ti ti-adjustments-horizontal", size: "medium" },
  );
