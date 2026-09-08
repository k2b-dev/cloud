import { Link, type LinkNavigateEvent, navigate } from "@k2b/ssr/nav";
import { query as solidQuery } from "@k2b/stdlib/solid";
import {
  Button,
  type DropdownItem,
  FileDropzone,
  IconButton,
  Lightbox,
  openSpotlightSearch,
  Placeholder,
  prompts,
  ScrollArea,
  toast,
} from "@k2b/ui";
import type { AiConversation, AiConversationPage, AiProject, AiProjectKnowledge } from "@valentinkolb/cloud/ai";
import { openCloudResourcePicker } from "@valentinkolb/cloud/browser/resource-picker";
import { coreClient } from "@valentinkolb/cloud/clients/core";
import { formatDateTime } from "@valentinkolb/cloud/shared";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { assistantApi } from "../api/client";
import type { AssistantProjectContextSnapshot } from "../project-context";
import {
  AssistantContextEmpty,
  type AssistantContextFile,
  AssistantContextRow,
  AssistantContextRows,
  AssistantContextSection,
  AssistantContextViewAll,
  assistantContextCountTitle,
  assistantProjectFileSource,
  downloadAssistantContextFile,
  isAssistantContextImage,
  loadAssistantContextImages,
  openAssistantCloudReference,
  openAssistantContextFiles,
  openAssistantKnowledgeSearch,
  openAssistantMarkdown,
} from "./AssistantContextContent";
import { openAssistantConversationEditor } from "./AssistantConversationEditor";
import { openAssistantProjectSettingsDialog } from "./AssistantProjectSettingsDialog";
import { type AssistantLiveInvalidation, matchesAssistantInvalidation, useAssistantLive } from "./assistant-live";
import { assistantConversationHref } from "./assistant-navigation";
import { useAssistantCopy, useAssistantText } from "./ui-copy";

type Props = {
  project: AiProject;
  initialPage: AiConversationPage;
  initialContext?: AssistantProjectContextSnapshot | null;
  composer: JSX.Element;
  onOpenConversation: (conversationId: string) => Promise<boolean>;
};

const CONTEXT_PREVIEW_LIMIT = 3;

export default function AssistantProjectView(props: Props) {
  const text = useAssistantText();
  const copy = useAssistantCopy();
  const chats = solidQuery.createInfinite<string, AiConversationPage, number, AssistantLiveInvalidation>({
    source: () => props.project.id,
    initial: { source: props.project.id, pages: [props.initialPage] },
    loadPage: (projectId, { cursor, abortSignal }) =>
      assistantApi.listConversationsPage({
        projectId,
        page: cursor ?? 1,
        perPage: 20,
        signal: abortSignal,
      }),
    getNextCursor: (page) => (page.hasNext ? page.page + 1 : null),
  });
  const context = solidQuery.create<string, AssistantProjectContextSnapshot, AssistantLiveInvalidation>({
    source: () => props.project.id,
    initial: props.initialContext ? { source: props.initialContext.projectId, data: props.initialContext } : undefined,
    load: (projectId, { abortSignal }) => assistantApi.loadProjectContext(projectId, abortSignal),
  });
  const live = useAssistantLive();
  const unregisterChats = live.register({
    matches: matchesAssistantInvalidation(["conversation-list"], { projectId: props.project.id }),
    invalidate: (invalidation) => chats.invalidate(invalidation),
  });
  const unregisterContext = live.register({
    matches: matchesAssistantInvalidation(["project-detail", "project-context"], { projectId: props.project.id }),
    invalidate: (invalidation) => context.invalidate(invalidation),
  });
  onCleanup(() => {
    unregisterChats();
    unregisterContext();
  });
  const chatItems = createMemo(() => chats.pages().flatMap((page) => page.items));
  let chatListViewport: HTMLDivElement | undefined;
  let loadMoreSentinel: HTMLDivElement | undefined;
  const [contextAction, setContextAction] = createSignal<string | null>(null);
  const [lightbox, setLightbox] = createSignal<{ images: Awaited<ReturnType<typeof loadAssistantContextImages>>; index: number } | null>(
    null,
  );
  const projectFileSource = assistantProjectFileSource(props.project.id, () => context.data()?.files ?? []);
  const contextFiles = (): AssistantContextFile[] =>
    (context.data()?.files ?? []).map((file) => ({
      id: file.id,
      path: file.path,
      mediaType: file.mediaType,
      size: file.size,
      scope: "project",
      source: projectFileSource,
    }));
  const imageFiles = () => contextFiles().filter(isAssistantContextImage);
  const regularFiles = () => contextFiles().filter((file) => !isAssistantContextImage(file));
  const canWrite = () => props.project.permission !== "read";
  const openImages = async (selected?: AssistantContextFile) => {
    try {
      const images = await loadAssistantContextImages(contextFiles());
      const index = selected
        ? Math.max(
            0,
            images.findIndex((entry) => entry.file.id === selected.id),
          )
        : 0;
      setLightbox({ images, index });
    } catch (error) {
      void prompts.error(error instanceof Error ? error.message : text("Images could not be loaded."), { title: text("Could not open images") });
    }
  };

  const readError = async (response: Response, fallback: string) => {
    const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
    return typeof payload?.message === "string" && payload.message.trim() ? payload.message : fallback;
  };

  const runContextAction = async (key: string, success: string, action: () => Promise<Response>) => {
    if (contextAction()) return;
    setContextAction(key);
    try {
      const response = await action();
      if (!response.ok) throw new Error(await readError(response, text("Project context could not be updated.")));
      await context.refresh();
      toast.success(success);
    } catch (error) {
      void prompts.error(error instanceof Error ? error.message : text("Project context could not be updated."), {
        title: text("Could not update Project context"),
      });
    } finally {
      setContextAction(null);
    }
  };

  const editKnowledge = async (item?: AiProjectKnowledge) => {
    const values = await prompts.form({
      title: text(item ? "Edit knowledge" : "Add knowledge"),
      icon: "ti ti-bulb",
      confirmText: text(item ? "Save knowledge" : "Add knowledge"),
      size: "large",
      fields: {
        title: { type: "text", label: text("Title"), default: item?.title ?? "", required: true, maxLength: 200 },
        content: {
          type: "text",
          label: text("Content"),
          default: item?.content ?? "",
          required: true,
          multiline: true,
          markdown: true,
          lines: 10,
          description: text("Reference material for future turns in this Project."),
        },
      },
    });
    if (!values) return;
    await runContextAction(item ? `knowledge:${item.id}` : "knowledge:new", item ? "Knowledge updated" : "Knowledge added", () =>
      item
        ? coreClient.ai.projects[":projectId"].knowledge[":knowledgeId"].$patch({
            param: { projectId: props.project.id, knowledgeId: item.id },
            json: { title: values.title, content: values.content },
          })
        : coreClient.ai.projects[":projectId"].knowledge.$post({
            param: { projectId: props.project.id },
            json: { title: values.title, content: values.content },
          }),
    );
  };

  const deleteKnowledge = async (item: AiProjectKnowledge) => {
    if (!(await prompts.confirm(copy().removeFromProject({ name: item.title }), { title: text("Delete knowledge"), variant: "danger" }))) return;
    await runContextAction(`knowledge:${item.id}`, "Knowledge deleted", () =>
      coreClient.ai.projects[":projectId"].knowledge[":knowledgeId"].$delete({
        param: { projectId: props.project.id, knowledgeId: item.id },
      }),
    );
  };

  const fileContent = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error(text("File could not be read.")));
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
      reader.readAsDataURL(file);
    });

  const uploadFiles = async (files: File[]) => {
    for (const file of files) {
      await runContextAction(`file:${file.name}`, `${file.name} uploaded`, async () =>
        coreClient.ai.projects[":projectId"].files.$post({
          param: { projectId: props.project.id },
          json: {
            path: file.name,
            mediaType: file.type || "application/octet-stream",
            content: await fileContent(file),
            encoding: "base64",
          },
        }),
      );
    }
  };

  const chooseFiles = (imagesOnly = false) =>
    prompts.dialog<void>(
      (close) => (
        <div class="k2b-dialog__body">
          <FileDropzone
            multiple
            accept={imagesOnly ? "image/*" : undefined}
            title={text(imagesOnly ? "Add Project images" : "Add Project files")}
            subtitle={text("Drop files here or choose them from this device")}
            onDrop={(files) => {
              close();
              void uploadFiles(files);
            }}
          />
        </div>
      ),
      { title: text(imagesOnly ? "Add images" : "Add files"), icon: imagesOnly ? "ti ti-photo" : "ti ti-files", size: "medium" },
    );

  const deleteFile = async (file: Pick<AssistantContextFile, "id" | "path">) => {
    if (!(await prompts.confirm(copy().removeFromProject({ name: file.path }), { title: text("Delete file"), variant: "danger" }))) return;
    await runContextAction(`file:${file.id}`, "File deleted", () =>
      coreClient.ai.projects[":projectId"].files[":fileId"].$delete({ param: { projectId: props.project.id, fileId: file.id } }),
    );
  };

  const addReference = async () => {
    const current = context.data();
    const selected = await openCloudResourcePicker({
      title: text("Add Cloud reference"),
      excludeRefs: current?.references.map((reference) => reference.ref),
      requireReader: true,
    });
    if (!selected) return;
    await runContextAction("reference:new", "Cloud reference added", () =>
      coreClient.ai.projects[":projectId"].references.$post({
        param: { projectId: props.project.id },
        json: { ref: selected.ref, label: selected.title },
      }),
    );
  };

  const deleteReference = async (reference: NonNullable<AssistantProjectContextSnapshot["references"]>[number]) => {
    const label = reference.label || `${reference.ref.type} · ${reference.ref.id}`;
    if (!(await prompts.confirm(copy().removeFromProject({ name: label }), { title: text("Remove Cloud reference"), variant: "danger" }))) return;
    await runContextAction(`reference:${reference.id}`, "Cloud reference removed", () =>
      coreClient.ai.projects[":projectId"].references[":referenceId"].$delete({
        param: { projectId: props.project.id, referenceId: reference.id },
      }),
    );
  };

  const downloadFile = async (file: AssistantContextFile) => {
    try {
      await downloadAssistantContextFile(file);
    } catch (error) {
      void prompts.error(error instanceof Error ? error.message : text("File could not be downloaded."), { title: text("Could not download file") });
    }
  };

  const knowledgeMenu = (item: AiProjectKnowledge): DropdownItem[] =>
    canWrite()
      ? [
          { icon: "ti ti-pencil", label: text("Edit"), action: () => void editKnowledge(item), disabled: Boolean(contextAction()) },
          {
            icon: "ti ti-trash",
            label: text("Delete"),
            variant: "danger",
            action: () => void deleteKnowledge(item),
            disabled: Boolean(contextAction()),
          },
        ]
      : [];

  const fileMenu = (file: AssistantContextFile): DropdownItem[] => [
    { icon: "ti ti-download", label: text("Download"), action: () => void downloadFile(file) },
    ...(canWrite()
      ? ([
          {
            icon: "ti ti-trash",
            label: text("Delete"),
            variant: "danger",
            action: () => void deleteFile(file),
            disabled: Boolean(contextAction()),
          },
        ] satisfies DropdownItem[])
      : []),
  ];

  const referenceMenu = (reference: NonNullable<AssistantProjectContextSnapshot["references"]>[number]): DropdownItem[] =>
    canWrite()
      ? [
          {
            icon: "ti ti-trash",
            label: text("Remove from Project"),
            variant: "danger",
            action: () => void deleteReference(reference),
            disabled: Boolean(contextAction()),
          },
        ]
      : [];

  const openReferences = async (references: NonNullable<AssistantProjectContextSnapshot["references"]>) => {
    const selected = await prompts.search<(typeof references)[number]>(
      ({ query }) => {
        const normalized = query.trim().toLocaleLowerCase();
        return references
          .map((reference) => ({ reference, title: reference.label || `${reference.ref.type} · ${reference.ref.id}` }))
          .filter(({ title }) => !normalized || title.toLocaleLowerCase().includes(normalized))
          .map(({ reference, title }) => ({ value: reference, label: title, icon: "ti ti-link" }));
      },
      { title: text("References"), icon: "ti ti-link", placeholder: text("Search references…"), minQueryLength: 0, size: "small" },
    );
    if (!selected?.value) return;
    await openAssistantCloudReference(selected.value.label || `${selected.value.ref.type} · ${selected.value.ref.id}`, selected.value.ref);
  };

  const loadMore = async () => {
    if (!chats.loadingMore() && chats.hasMore()) await chats.loadMore();
  };
  const openConversation = async (conversationId: string, nav: LinkNavigateEvent) => {
    try {
      if (await props.onOpenConversation(conversationId)) nav.push(undefined, { scroll: "manual" });
    } catch {
      nav.fallback();
    }
  };
  const searchChats = async () => {
    const selected = await openSpotlightSearch<AiConversation>({
      title: copy().searchChatsIn({ project: props.project.name }),
      icon: "ti ti-search",
      placeholder: text("Search chats…"),
      minQueryLength: 1,
      noResultsText: text("No chats found."),
      resolve: async ({ query, abortSignal }) => {
        const conversations = await assistantApi.listConversations({
          projectId: props.project.id,
          q: query.trim(),
          limit: 20,
          signal: abortSignal,
        });
        return conversations.map((conversation) => ({
          value: conversation,
          label: conversation.title,
          desc: conversation.description || formatDateTime(conversation.updatedAt),
          icon: "ti ti-message-circle",
        }));
      },
    });
    if (!selected?.value) return;
    if (await props.onOpenConversation(selected.value.id)) {
      navigate(assistantConversationHref("/app/assistant", selected.value.id), { scroll: "manual" });
    }
  };

  onMount(() => {
    if (!chatListViewport || !loadMoreSentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { root: chatListViewport, rootMargin: "240px" },
    );
    observer.observe(loadMoreSentinel);
    onCleanup(() => observer.disconnect());
  });

  return (
    <ScrollArea class="min-h-0 flex-1 p-[var(--ui-space-section)]">
      <div class="mx-auto grid min-h-full w-full max-w-[88rem] gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <main class="flex min-h-[36rem] min-w-0 flex-col">
          <header class="flex min-w-0 items-start gap-4">
            <div class="min-w-0">
              <p class="text-xs text-dimmed">{text("Project")}</p>
              <h1 class="truncate text-xl font-semibold text-primary">{props.project.name}</h1>
              <Show when={props.project.description}>
                <p class="mt-1 line-clamp-2 text-sm text-secondary">{props.project.description}</p>
              </Show>
            </div>
          </header>

          <div class="mx-auto mt-auto flex w-full max-w-4xl flex-col gap-3 pt-16">
            <section class="flex min-h-0 flex-col gap-2" aria-labelledby="project-chats-heading">
              <header class="flex min-h-8 items-center justify-between gap-3 px-1">
                <div class="flex min-w-0 items-baseline gap-2">
                  <h2 id="project-chats-heading" class="text-xs font-medium text-dimmed">
                    {text("Recent chats")}
                  </h2>
                  <span class="text-xs tabular-nums text-dimmed">{chats.pages()[0]?.total ?? chatItems().length}</span>
                </div>
                <IconButton size="xs" variant="subtle" label={copy().searchChatsIn({ project: props.project.name })} onClick={() => void searchChats()}>
                  <i class="ti ti-search" aria-hidden="true" />
                </IconButton>
              </header>
              <Show when={chats.error()}>{(error) => <p class="px-2 text-xs text-danger">{error().message}</p>}</Show>
              <ScrollArea
                ref={chatListViewport}
                class="max-h-40"
                aria-busy={chats.loading() || chats.refreshing() || chats.loadingMore()}
                scrollPreserveKey="assistant-project-chats"
              >
                <div class="flex flex-col gap-0.5">
                  <For each={chatItems()}>
                    {(chat: AiConversation) => (
                      <div class="group flex min-w-0 items-center gap-1 rounded-lg transition-colors hover:bg-[var(--ui-surface-subtle)] focus-within:bg-[var(--ui-surface-subtle)]">
                        <Link
                          href={assistantConversationHref("/app/assistant", chat.id)}
                          class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 focus-visible:outline focus-visible:outline-2"
                          scroll="manual"
                          onNavigate={(nav) => openConversation(chat.id, nav)}
                        >
                          <i class="ti ti-message-circle shrink-0 text-dimmed" aria-hidden="true" />
                          <span class="min-w-0 flex-1 truncate text-sm text-primary">{chat.title}</span>
                          <time class="shrink-0 text-xs text-dimmed">{formatDateTime(chat.updatedAt)}</time>
                        </Link>
                        <IconButton
                          class="mr-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                          size="xs"
                          variant="subtle"
                          label={copy().editNamed({ name: chat.title })}
                          onClick={() => void openAssistantConversationEditor(chat)}
                        >
                          <i class="ti ti-settings" aria-hidden="true" />
                        </IconButton>
                      </div>
                    )}
                  </For>
                </div>
                <Show when={!chats.error() && chatItems().length === 0}>
                  <p class="px-2 py-3 text-sm text-dimmed">{text("No Project chats yet.")}</p>
                </Show>
                <div ref={loadMoreSentinel} class="flex min-h-4 items-center justify-center" aria-live="polite">
                  <Show when={chats.loading() || chats.refreshing() || chats.loadingMore()}>
                    <span class="text-xs text-dimmed">{text("Loading chats…")}</span>
                  </Show>
                </div>
              </ScrollArea>
            </section>

            <div class="mx-auto w-full max-w-3xl shrink-0">{props.composer}</div>
          </div>
        </main>

        <aside
          class="min-h-0 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-4 lg:sticky lg:top-[var(--ui-space-section)]"
          aria-label={text("Project context")}
        >
          <div class="flex flex-col gap-5">
            <AssistantContextSection
              title={props.project.name}
              identity
              action={
                <Show when={props.project.permission === "admin"}>
                  <IconButton
                    size="xs"
                    label={text("Project settings")}
                    onClick={() => void openAssistantProjectSettingsDialog(props.project, live)}
                  >
                    <i class="ti ti-settings" aria-hidden="true" />
                  </IconButton>
                </Show>
              }
            >
              <AssistantContextRow
                icon="ti ti-eye"
                title={text("View project")}
                onClick={() =>
                  void openAssistantMarkdown(
                    text("Project instructions"),
                    props.project.instructions || text("No Project instructions yet."),
                    "ti ti-adjustments-horizontal",
                  )
                }
              />
            </AssistantContextSection>

            <Show
              when={context.data()}
              fallback={
                <Placeholder
                  state={context.error() ? "error" : "loading"}
                  title={text(context.error() ? "Could not load Project context" : "Loading Project context")}
                  action={
                    context.error() ? (
                      <Button size="sm" variant="secondary" onClick={() => void context.refresh()}>
                        {text("Retry")}
                      </Button>
                    ) : undefined
                  }
                />
              }
            >
              {(value) => (
                <>
                  <AssistantContextSection
                    title={text("Project knowledge")}
                    action={
                      <Show when={props.project.permission !== "read"}>
                        <IconButton size="xs" label={text("Add Project knowledge")} onClick={() => void editKnowledge()}>
                          <i class="ti ti-plus" aria-hidden="true" />
                        </IconButton>
                      </Show>
                    }
                  >
                    <Show
                      when={value().knowledge.length > 0}
                      fallback={<AssistantContextEmpty>{text("No Project knowledge yet.")}</AssistantContextEmpty>}
                    >
                      <AssistantContextRows>
                        <For each={value().knowledge.slice(0, CONTEXT_PREVIEW_LIMIT)}>
                          {(item) => (
                            <AssistantContextRow
                              icon="ti ti-bulb"
                              title={item.title}
                              onClick={() => void openAssistantMarkdown(item.title, item.content, "ti ti-bulb")}
                              menuItems={knowledgeMenu(item)}
                              menuLabel={`${text("Actions for")} ${item.title}`}
                            />
                          )}
                        </For>
                        <Show when={value().knowledge.length > CONTEXT_PREVIEW_LIMIT}>
                          <AssistantContextViewAll onClick={() => void openAssistantKnowledgeSearch(value().knowledge)} />
                        </Show>
                      </AssistantContextRows>
                    </Show>
                  </AssistantContextSection>

                  <AssistantContextSection
                    title={assistantContextCountTitle(imageFiles().length, text("Image"), text("Images"))}
                    action={
                      <Show when={props.project.permission !== "read"}>
                        <IconButton size="xs" label={text("Add images")} onClick={() => void chooseFiles(true)}>
                          <i class="ti ti-plus" aria-hidden="true" />
                        </IconButton>
                      </Show>
                    }
                  >
                    <Show when={imageFiles()[0]} fallback={<AssistantContextEmpty>{text("No Project images yet.")}</AssistantContextEmpty>}>
                      {(file) => (
                        <AssistantContextRows>
                          <AssistantContextRow
                            icon="ti ti-photo"
                            title={file().path.replace(/^.*\//u, "")}
                            onClick={() => void openImages(file())}
                            menuItems={fileMenu(file())}
                            menuLabel={`${text("Actions for")} ${file().path.replace(/^.*\//u, "")}`}
                          />
                          <Show when={imageFiles().length > 1}>
                            <AssistantContextViewAll onClick={() => void openImages()} />
                          </Show>
                        </AssistantContextRows>
                      )}
                    </Show>
                  </AssistantContextSection>

                  <AssistantContextSection
                    title={assistantContextCountTitle(regularFiles().length, text("File"), text("Files"))}
                    action={
                      <Show when={props.project.permission !== "read"}>
                        <IconButton size="xs" label={text("Add files")} onClick={() => void chooseFiles()}>
                          <i class="ti ti-plus" aria-hidden="true" />
                        </IconButton>
                      </Show>
                    }
                  >
                    <Show when={regularFiles().length > 0} fallback={<AssistantContextEmpty>{text("No Project files yet.")}</AssistantContextEmpty>}>
                      <AssistantContextRows>
                        <For each={regularFiles().slice(0, CONTEXT_PREVIEW_LIMIT)}>
                          {(file) => (
                            <AssistantContextRow
                              icon="ti ti-file"
                              title={file.path.replace(/^.*\//u, "")}
                              onClick={() => void openAssistantContextFiles(regularFiles(), file)}
                              menuItems={fileMenu(file)}
                              menuLabel={`${text("Actions for")} ${file.path.replace(/^.*\//u, "")}`}
                            />
                          )}
                        </For>
                        <Show when={regularFiles().length > CONTEXT_PREVIEW_LIMIT}>
                          <AssistantContextViewAll onClick={() => void openAssistantContextFiles(regularFiles())} />
                        </Show>
                      </AssistantContextRows>
                    </Show>
                  </AssistantContextSection>

                  <AssistantContextSection
                    title={assistantContextCountTitle(value().references.length, text("Reference"), text("References"))}
                    action={
                      <Show when={props.project.permission !== "read"}>
                        <IconButton size="xs" label={text("Add reference")} onClick={() => void addReference()}>
                          <i class="ti ti-plus" aria-hidden="true" />
                        </IconButton>
                      </Show>
                    }
                  >
                    <Show
                      when={value().references.length > 0}
                      fallback={<AssistantContextEmpty>{text("No Project references yet.")}</AssistantContextEmpty>}
                    >
                      <AssistantContextRows>
                        <For each={value().references.slice(0, CONTEXT_PREVIEW_LIMIT)}>
                          {(reference) => {
                            const label = () => reference.label || `${reference.ref.type} · ${reference.ref.id}`;
                            return (
                              <AssistantContextRow
                                icon="ti ti-link"
                                title={label()}
                                onClick={() => void openAssistantCloudReference(label(), reference.ref)}
                                menuItems={referenceMenu(reference)}
                                menuLabel={`${text("Actions for")} ${label()}`}
                              />
                            );
                          }}
                        </For>
                        <Show when={value().references.length > CONTEXT_PREVIEW_LIMIT}>
                          <AssistantContextViewAll onClick={() => void openReferences(value().references)} />
                        </Show>
                      </AssistantContextRows>
                    </Show>
                  </AssistantContextSection>
                </>
              )}
            </Show>
          </div>
        </aside>
      </div>
      <Show when={lightbox()}>
        {(state) => (
          <Lightbox images={state().images.map((entry) => entry.image)} initialIndex={state().index} onClose={() => setLightbox(null)} />
        )}
      </Show>
    </ScrollArea>
  );
}
