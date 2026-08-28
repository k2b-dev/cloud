import { type DateContext, dates, fileIcons } from "@k2b/stdlib";
import { clipboard, files } from "@k2b/stdlib/browser";
import { query } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Avatar,
  DescriptionList,
  DetailPanel,
  IconButton,
  IconButtonLink,
  ProgressBar,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import type { NotebookPresenceParticipant } from "@valentinkolb/cloud/contracts";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { NamedBlockSummary } from "../../../../lib/named-blocks";
import type { Backlink } from "../../../../service/links";
import { buildVersionsUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import type { Attachment } from "../editor/attachments-client";
import { buildAttachmentContentUrl, confirmAndDownload, formatBytes } from "../editor/attachments-client";
import { setDetailPanelOpen } from "../settings/NotebookSettingsStore";
import {
  ATTACHMENTS_UPDATE_EVENT,
  DETAIL_PANEL_STATE_EVENT,
  DETAIL_PANEL_TOGGLE_EVENT,
  EDITOR_COPY_EVENT,
  EDITOR_DOWNLOAD_EVENT,
  EDITOR_PDF_EVENT,
  NAMED_BLOCK_SCROLL_EVENT,
  NAMED_BLOCKS_UPDATE_EVENT,
  NOTE_SOFT_NAVIGATED_EVENT,
  NOTE_TITLE_CHANGED_EVENT,
  PRESENCE_EVENT,
  RICH_MODE_CHANGED_EVENT,
  TASKS_UPDATE_EVENT,
  TOC_SCROLL_EVENT,
  TOC_UPDATE_EVENT,
  TOGGLE_RICH_MODE_EVENT,
} from "./events";
import { openNotePdfDialog } from "./NotePdfDialog";
import type { TaskProgress } from "./tasks";
import type { TocItem } from "./toc";

type Props = {
  mode: "edit" | "read";
  initiallyOpen: boolean;
  tocItems: TocItem[];
  taskProgress: TaskProgress;
  /** Attachments referenced from the current note's markdown — initial SSR
   *  hydration. Live updates flow through `ATTACHMENTS_UPDATE_EVENT`. */
  attachments: Attachment[];
  backlinks: Backlink[];
  currentNotebookId: string;
  notebookId: string;
  noteId: string;
  noteTitle: string;
  contentMd: string | null;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
  isLocked: boolean;
  dateConfig: DateContext;
  namedBlocks: NamedBlockSummary[];
};

type SoftNavigatedDetail = {
  noteId: string;
  noteTitle: string;
  contentMd: string | null;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
  isLocked: boolean;
  tocItems: TocItem[];
  taskProgress: TaskProgress;
  attachments: Attachment[];
  backlinks: Backlink[];
  namedBlocks: NamedBlockSummary[];
};

type NoteActivityItem = {
  id: string;
  actor: { displayName: string };
  action: string;
  lastOccurredAt: string;
};

const namedBlockSnippet = (block: NamedBlockSummary): string => {
  const name = JSON.stringify(block.name);
  switch (block.type) {
    case "table":
      return `const rows = current.table(${name})?.rows ?? [];`;
    case "list":
      return `const items = current.list(${name})?.items ?? [];`;
    case "data":
      return `const data = current.data(${name})?.value ?? {};`;
    case "section":
      return `const markdown = current.section(${name})?.markdown ?? "";`;
    case "script":
      return `// @${block.name} marks a script block. Script blocks are not readable through current.* yet.`;
    default:
      return `// @${block.name} has no typed script helper yet.`;
  }
};

/**
 * Right-side detail panel — outline + backlinks + (edit-mode) online users +
 * actions + note metadata. Single island keeps editor bridge state and panel
 * interactions together while `DetailPanel.Body` remains the only scroll owner.
 *
 * Visibility is controlled via the toolbar's panel-toggle button and the
 * mobile-only "Close panel" action inside the panel.
 *
 * Event flow (all through window CustomEvents, see `events.ts`):
 *  - editor toolbar / readonly footer → DETAIL_PANEL_TOGGLE_EVENT → toggles open
 *  - editor → TOC_UPDATE_EVENT → refresh outline
 *  - editor → PRESENCE_EVENT → refresh online list
 *  - panel → TOC_SCROLL_EVENT → editor scrolls to heading line
 *  - panel → TOGGLE_RICH_MODE_EVENT → editor flips its `richMode` signal
 *  - panel → EDITOR_COPY_EVENT / EDITOR_DOWNLOAD_EVENT → editor uses its
 *    current `ytext` rather than the SSR-time `contentMd` snapshot
 *  - readonly rendering falls back to `contentMd` prop directly (no editor present)
 */
export default function NotebookDetailPanel(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const [open, setOpen] = createSignal(props.initiallyOpen);
  const [tocItems, setTocItems] = createSignal<TocItem[]>(props.tocItems);
  const [tasks, setTasks] = createSignal<TaskProgress>(props.taskProgress);
  const [noteId, setNoteId] = createSignal(props.noteId);
  const [noteTitle, setNoteTitle] = createSignal(props.noteTitle);
  const [contentMd, setContentMd] = createSignal(props.contentMd);
  const [backlinks, setBacklinks] = createSignal<Backlink[]>(props.backlinks);
  const [createdAt, setCreatedAt] = createSignal(props.createdAt);
  const [updatedAt, setUpdatedAt] = createSignal(props.updatedAt);
  const [lockedAt, setLockedAt] = createSignal(props.lockedAt);
  const [, setIsLocked] = createSignal(props.isLocked);
  const [namedBlocks, setNamedBlocks] = createSignal<NamedBlockSummary[]>(props.namedBlocks);
  const noteActivity = query.create<string, NoteActivityItem[]>({
    source: noteId,
    load: async (currentNoteId, { abortSignal }) => {
      const response = await apiClient.overview.activity.$get(
        { query: { notebook: props.notebookId, note: currentNoteId, limit: "10" } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t().loadActivityFailed);
      return (await response.json()).data;
    },
  });

  const buildAttachmentSource = (currentNoteId: string, ids: string[]) => `${props.notebookId}:${currentNoteId}:${ids.join(",")}`;
  const initialAttachmentIds = props.attachments.map((attachment) => attachment.id);
  const [attachmentRoute, setAttachmentRoute] = createSignal({ noteId: props.noteId, ids: initialAttachmentIds });
  const initialAttachmentSource = buildAttachmentSource(props.noteId, initialAttachmentIds);
  const [attachmentSnapshot, setAttachmentSnapshot] = createSignal<{ source: string; attachments: Attachment[] } | null>({
    source: initialAttachmentSource,
    attachments: props.attachments,
  });
  const attachmentSource = createMemo(() => buildAttachmentSource(attachmentRoute().noteId, attachmentRoute().ids));
  const attachmentMetadata = query.create<string, { source: string; attachments: Attachment[] }>({
    source: attachmentSource,
    initial: {
      source: initialAttachmentSource,
      data: {
        source: initialAttachmentSource,
        attachments: props.attachments,
      },
    },
    load: async (source, { abortSignal }) => {
      const exactSnapshot = attachmentSnapshot();
      if (exactSnapshot?.source === source) return exactSnapshot;
      const ids = source.split(":").at(-1)?.split(",").filter(Boolean) ?? [];
      if (ids.length === 0) return { source, attachments: [] };
      const response = await apiClient[":id"].attachments.$get({ param: { id: props.notebookId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(t().loadAttachmentsFailed({ status: response.status }));
      const byId = new Map((await response.json()).map((attachment) => [attachment.id, attachment]));
      return { source, attachments: ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])) };
    },
  });
  const visibleAttachments = createMemo(() => {
    const loaded = attachmentMetadata.data();
    return loaded?.source === attachmentSource() ? loaded.attachments : [];
  });
  const [participants, setParticipants] = createSignal<NotebookPresenceParticipant[]>([]);
  // Mirrors the editor's richMode signal — kept in sync via window events.
  // Default `true` matches the editor's initial state, so SSR and the first
  // client render agree even if the editor's broadcast hasn't arrived yet.
  const [isRich, setIsRich] = createSignal(true);

  const downloadFilename = () => `${(noteTitle() || "note").trim() || "note"}.md`;

  const toggleOpen = () => {
    const next = !open();
    setOpen(next);
    setDetailPanelOpen(next);
  };

  const closePanel = () => {
    setOpen(false);
    setDetailPanelOpen(false);
  };

  // Broadcast open state so the editor toolbar's toggle button can flip its
  // expand/collapse icon. Fires once on hydration with the initial value, then
  // on every toggle.
  createEffect(() => {
    window.dispatchEvent(new CustomEvent(DETAIL_PANEL_STATE_EVENT, { detail: { isOpen: open() } }));
  });

  const toggleRichMode = () => {
    window.dispatchEvent(new CustomEvent(TOGGLE_RICH_MODE_EVENT));
  };

  const copyContent = () => {
    if (props.mode === "edit") {
      window.dispatchEvent(new CustomEvent(EDITOR_COPY_EVENT));
    } else {
      void clipboard.copy(contentMd() ?? "").then(
        () => toast.success(t().contentCopied),
        () => toast.error(t().contentCopyFailed),
      );
    }
  };

  const downloadContent = () => {
    if (props.mode === "edit") {
      window.dispatchEvent(new CustomEvent(EDITOR_DOWNLOAD_EVENT));
    } else {
      files.downloadFileFromContent(contentMd() ?? "", downloadFilename(), "text/markdown");
    }
  };

  const openPdf = (markdown: string) => {
    void openNotePdfDialog({
      notebookId: props.notebookId,
      noteId: noteId(),
      noteTitle: noteTitle(),
      markdown,
    });
  };

  const downloadPdf = () => {
    if (props.mode === "edit") {
      window.dispatchEvent(new CustomEvent(EDITOR_PDF_EVENT, { detail: { open: openPdf } }));
    } else {
      openPdf(contentMd() ?? "");
    }
  };

  const onTocItemClick = (event: MouseEvent, id: string) => {
    if (props.mode === "read") return;
    event.preventDefault();
    window.dispatchEvent(new CustomEvent(TOC_SCROLL_EVENT, { detail: { id } }));
  };

  const scrollToNamedBlock = (block: NamedBlockSummary) => {
    window.dispatchEvent(new CustomEvent(NAMED_BLOCK_SCROLL_EVENT, { detail: block }));
  };

  const copyNamedBlockSnippet = async (event: MouseEvent, block: NamedBlockSummary) => {
    event.stopPropagation();
    try {
      await clipboard.copy(namedBlockSnippet(block));
      toast.success(t().referenceCopied, { title: t().copied, iconClass: "ti ti-clipboard-check" });
    } catch {
      toast.error(t().referenceCopyFailed);
    }
  };

  onMount(() => {
    const onTocUpdate = (event: Event) => {
      const detail = (event as CustomEvent<TocItem[]>).detail;
      if (Array.isArray(detail)) setTocItems(detail);
    };
    const onTasksUpdate = (event: Event) => {
      const detail = (event as CustomEvent<TaskProgress>).detail;
      if (detail && typeof detail.done === "number" && typeof detail.total === "number") {
        setTasks(detail);
      }
    };
    const onPresenceUpdate = (event: Event) => {
      const detail = (event as CustomEvent<NotebookPresenceParticipant[]>).detail;
      if (Array.isArray(detail)) setParticipants(detail);
    };
    const onToggle = () => toggleOpen();
    const onRichChange = (event: Event) => {
      const detail = (event as CustomEvent<{ isRich: boolean }>).detail;
      if (typeof detail?.isRich === "boolean") setIsRich(detail.isRich);
    };

    const onAttachmentsUpdate = (event: Event) => {
      const ids = (event as CustomEvent<string[]>).detail ?? [];
      const nextRoute = { noteId: noteId(), ids };
      const nextSource = buildAttachmentSource(nextRoute.noteId, nextRoute.ids);
      if (attachmentSnapshot()?.source !== nextSource) setAttachmentSnapshot(null);
      setAttachmentRoute(nextRoute);
    };
    const onNamedBlocksUpdate = (event: Event) => {
      const detail = (event as CustomEvent<NamedBlockSummary[]>).detail;
      if (Array.isArray(detail)) setNamedBlocks(detail);
    };
    const onSoftNavigated = (event: Event) => {
      const detail = (event as CustomEvent<SoftNavigatedDetail>).detail;
      if (!detail?.noteId) return;
      setNoteId(detail.noteId);
      setNoteTitle(detail.noteTitle);
      setContentMd(detail.contentMd);
      setCreatedAt(detail.createdAt);
      setUpdatedAt(detail.updatedAt);
      setLockedAt(detail.lockedAt);
      setIsLocked(detail.isLocked);
      setTocItems(detail.tocItems);
      setTasks(detail.taskProgress);
      setBacklinks(detail.backlinks);
      const ids = detail.attachments.map((attachment) => attachment.id);
      setAttachmentSnapshot({ source: buildAttachmentSource(detail.noteId, ids), attachments: detail.attachments });
      setAttachmentRoute({ noteId: detail.noteId, ids });
      setNamedBlocks(detail.namedBlocks);
    };
    const onTitleChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ noteId?: string; title?: string }>).detail;
      if (detail?.noteId === noteId() && detail.title) setNoteTitle(detail.title);
    };

    window.addEventListener(TOC_UPDATE_EVENT, onTocUpdate);
    window.addEventListener(TASKS_UPDATE_EVENT, onTasksUpdate);
    window.addEventListener(ATTACHMENTS_UPDATE_EVENT, onAttachmentsUpdate);
    window.addEventListener(NAMED_BLOCKS_UPDATE_EVENT, onNamedBlocksUpdate);
    window.addEventListener(PRESENCE_EVENT, onPresenceUpdate);
    window.addEventListener(DETAIL_PANEL_TOGGLE_EVENT, onToggle);
    window.addEventListener(RICH_MODE_CHANGED_EVENT, onRichChange);
    window.addEventListener(NOTE_SOFT_NAVIGATED_EVENT, onSoftNavigated);
    window.addEventListener(NOTE_TITLE_CHANGED_EVENT, onTitleChanged);

    onCleanup(() => {
      window.removeEventListener(TOC_UPDATE_EVENT, onTocUpdate);
      window.removeEventListener(TASKS_UPDATE_EVENT, onTasksUpdate);
      window.removeEventListener(ATTACHMENTS_UPDATE_EVENT, onAttachmentsUpdate);
      window.removeEventListener(NAMED_BLOCKS_UPDATE_EVENT, onNamedBlocksUpdate);
      window.removeEventListener(PRESENCE_EVENT, onPresenceUpdate);
      window.removeEventListener(DETAIL_PANEL_TOGGLE_EVENT, onToggle);
      window.removeEventListener(RICH_MODE_CHANGED_EVENT, onRichChange);
      window.removeEventListener(NOTE_SOFT_NAVIGATED_EVENT, onSoftNavigated);
      window.removeEventListener(NOTE_TITLE_CHANGED_EVENT, onTitleChanged);
    });
  });

  return (
    <AppWorkspace.Detail id="notebook-detail" open={open()}>
      <DetailPanel>
        <DetailPanel.Header
          class="notebook-detail-panel-header"
          icon={`ti ${lockedAt() ? "ti-lock" : "ti-file-text"}`}
          title={noteTitle() || t().untitled}
          subtitle={lockedAt() ? t().lockedNote : props.mode === "edit" ? t().collaborativeNote : t().readOnlyNote}
          primaryActions={
            <nav aria-label={t().noteActionsLabel} class="flex flex-wrap items-center gap-1">
              <Show when={props.mode === "edit"}>
                <Tooltip.Anchor content={isRich() ? t().showMarkdown : t().showRichText}>
                  <IconButton label={isRich() ? t().showMarkdown : t().showRichText} size="sm" onClick={toggleRichMode}>
                    <i class={`ti ${isRich() ? "ti-markdown" : "ti-typography"}`} aria-hidden="true" />
                  </IconButton>
                </Tooltip.Anchor>
              </Show>
              <Tooltip.Anchor content={t().copyContent}>
                <IconButton label={t().copyNoteContent} size="sm" onClick={copyContent}>
                  <i class="ti ti-copy" aria-hidden="true" />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content={t().downloadMarkdown}>
                <IconButton label={t().downloadNoteMarkdown} size="sm" onClick={downloadContent}>
                  <i class="ti ti-download" aria-hidden="true" />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content={t().downloadPdf}>
                <IconButton label={t().downloadNotePdf} size="sm" onClick={downloadPdf}>
                  <i class="ti ti-file-type-pdf" aria-hidden="true" />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content={t().versionHistory}>
                <IconButtonLink href={buildVersionsUrl(props.notebookId, noteId())} size="sm" label={t().openVersionHistory}>
                  <i class="ti ti-history" aria-hidden="true" />
                </IconButtonLink>
              </Tooltip.Anchor>
              <Tooltip.Anchor content={t().graphView}>
                <IconButtonLink href={`/app/notebooks/${props.notebookId}?mode=graph&note=${noteId()}`} size="sm" label={t().openGraphView}>
                  <i class="ti ti-affiliate" aria-hidden="true" />
                </IconButtonLink>
              </Tooltip.Anchor>
            </nav>
          }
          actions={
            <Tooltip.Anchor content={t().closeDetails}>
              <IconButton label={t().closeNoteDetails} size="sm" onClick={closePanel}>
                <i class="ti ti-x" aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
          }
        />

        <DetailPanel.Body scrollPreserveKey="notebook-detail">
          <Show when={tasks().total > 0}>
            <DetailPanel.Summary title={t().taskProgress}>
              <div class="flex items-center justify-between text-xs">
                <span>{t().tasksDone({ done: tasks().done, total: tasks().total })}</span>
                <span class="text-dimmed tabular-nums">{Math.round((tasks().done / Math.max(1, tasks().total)) * 100)}%</span>
              </div>
              <ProgressBar
                class="mt-2"
                label={t().completedTasks}
                size="xs"
                tone="success"
                value={(tasks().done / Math.max(1, tasks().total)) * 100}
              />
            </DetailPanel.Summary>
          </Show>

          <Show when={tocItems().length > 0 || namedBlocks().length > 0}>
            <DetailPanel.Group label={t().noteStructure}>
              <Show when={tocItems().length > 0}>
                <DetailPanel.Section title={t().contents} icon="ti ti-list" tone="accent">
                  <div class="flex flex-col gap-1">
                    <For each={tocItems()}>
                      {(item) => (
                        <div style={`padding-left: ${Math.max(0, item.level - 1) * 0.75}rem`}>
                          <DetailPanel.Action
                            href={`#${item.id}`}
                            onClick={(event) => onTocItemClick(event, item.id)}
                            leading={<span class="font-mono text-[10px] text-dimmed">H{item.level}</span>}
                            title={item.text || t().untitled}
                          />
                        </div>
                      )}
                    </For>
                  </div>
                </DetailPanel.Section>
              </Show>

              <Show when={namedBlocks().length > 0}>
                <DetailPanel.Section title={t().references} icon="ti ti-at" tone="neutral" collapsible defaultOpen>
                  <ul class="flex flex-col gap-1">
                    <For each={namedBlocks()}>
                      {(block) => (
                        <li class="group flex items-center gap-1 text-xs">
                          <DetailPanel.Action
                            type="button"
                            class="min-w-0 flex-1"
                            onClick={() => scrollToNamedBlock(block)}
                            leading={<i class="ti ti-at" aria-hidden="true" />}
                            title={<code class="truncate">{block.name}</code>}
                            description={block.type}
                          />
                          <Tooltip.Anchor content={t().copyScriptSnippet({ name: block.name })} class="shrink-0">
                            <IconButton
                              label={t().copyScriptSnippet({ name: block.name })}
                              size="xs"
                              class="shrink-0 text-dimmed opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
                              onClick={(event) => void copyNamedBlockSnippet(event, block)}
                            >
                              <i class="ti ti-copy text-xs" aria-hidden="true" />
                            </IconButton>
                          </Tooltip.Anchor>
                        </li>
                      )}
                    </For>
                  </ul>
                </DetailPanel.Section>
              </Show>
            </DetailPanel.Group>
          </Show>

          <Show when={visibleAttachments().length > 0 || attachmentMetadata.error() || backlinks().length > 0}>
            <DetailPanel.Group label={t().relatedContent}>
              <Show when={visibleAttachments().length > 0 || attachmentMetadata.error()}>
                <DetailPanel.Section
                  title={t().attachments}
                  icon="ti ti-paperclip"
                  tone="neutral"
                  meta={visibleAttachments().length}
                  collapsible
                  defaultOpen
                >
                  <div class="flex flex-col gap-1">
                    <Show when={attachmentMetadata.error()}>
                      <DetailPanel.Action
                        type="button"
                        onClick={() => void attachmentMetadata.refresh()}
                        leading={<i class="ti ti-refresh" aria-hidden="true" />}
                        title={t().retryAttachments}
                        description={t().attachmentsLoadDescription}
                      />
                    </Show>
                    <For each={visibleAttachments()}>
                      {(att) => (
                        <DetailPanel.Action
                          type="button"
                          onClick={() => void confirmAndDownload(att.filename, buildAttachmentContentUrl(props.notebookId, att.id))}
                          leading={
                            <i
                              class={`ti ${fileIcons.getFileIcon({ name: att.filename, type: "file", mimeType: att.mimeType })}`}
                              aria-hidden="true"
                            />
                          }
                          title={att.filename}
                          description={formatBytes(att.sizeBytes)}
                        />
                      )}
                    </For>
                  </div>
                </DetailPanel.Section>
              </Show>

              <Show when={backlinks().length > 0}>
                <DetailPanel.Section title={t().linkedBy} icon="ti ti-link" tone="accent" meta={backlinks().length} collapsible defaultOpen>
                  <div class="flex flex-col gap-1">
                    <For each={backlinks()}>
                      {(bl) => {
                        const showNotebook = bl.notebookId !== props.currentNotebookId;
                        return (
                          <DetailPanel.Action
                            href={`/app/notebooks/${bl.notebookId}/notes/${bl.noteId}`}
                            leading={<i class="ti ti-file-text" aria-hidden="true" />}
                            title={bl.title || t().untitled}
                            description={showNotebook ? bl.notebookName : undefined}
                            trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                          />
                        );
                      }}
                    </For>
                  </div>
                </DetailPanel.Section>
              </Show>
            </DetailPanel.Group>
          </Show>

          <DetailPanel.Group label={t().noteContext}>
            <Show when={props.mode === "edit" && participants().length > 0}>
              <DetailPanel.Section title={t().online} icon="ti ti-users" tone="success" meta={participants().length}>
                <ul class="flex flex-col gap-1">
                  <For each={participants()}>
                    {(p) => (
                      <li class="flex items-center gap-3 px-2 py-1.5 text-sm text-primary">
                        <Avatar
                          name={p.displayName}
                          fallback={(p.displayName.trim() || "?").slice(0, 2).toUpperCase()}
                          src={
                            p.userId && p.avatarHash
                              ? `/api/accounts/users/${encodeURIComponent(p.userId)}/avatar?rev=${encodeURIComponent(p.avatarHash)}`
                              : undefined
                          }
                          size="xs"
                          style={`outline: 2px solid ${p.color}; outline-offset: 1px`}
                        />
                        <span class="truncate">{p.displayName}</span>
                        {p.peerCount > 1 && <span class="ml-auto text-[11px] text-dimmed">{t().tabs({ count: p.peerCount })}</span>}
                      </li>
                    )}
                  </For>
                </ul>
              </DetailPanel.Section>
            </Show>

            <DetailPanel.Section
              title={t().recentActivity}
              icon="ti ti-history"
              tone="neutral"
              meta={noteActivity.data()?.length ?? 0}
              collapsible
            >
              <Show
                when={!noteActivity.error()}
                fallback={
                  <DetailPanel.Action
                    type="button"
                    onClick={() => void noteActivity.refresh()}
                    leading={<i class="ti ti-refresh" aria-hidden="true" />}
                    title={t().retryActivity}
                    description={t().activityLoadDescription}
                  />
                }
              >
                <Show
                  when={(noteActivity.data()?.length ?? 0) > 0}
                  fallback={<p class="px-2 py-1 text-xs text-dimmed">{noteActivity.loading() ? t().loadingActivity : t().noActivity}</p>}
                >
                  <div class="flex flex-col gap-1">
                    <For each={noteActivity.data()}>
                      {(item) => (
                        <DetailPanel.Action
                          href={buildVersionsUrl(props.notebookId, noteId())}
                          leading={<Avatar name={item.actor.displayName} size="xs" />}
                          title={item.actor.displayName}
                          description={item.action === "note.edited" ? t().editedThisNote : item.action.replaceAll(".", " ")}
                          trailing={
                            <time datetime={item.lastOccurredAt}>
                              {dates.formatDateTimeRelative(item.lastOccurredAt, props.dateConfig)}
                            </time>
                          }
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </DetailPanel.Section>

            <DetailPanel.Section title={t().infoSection} icon="ti ti-info-circle" tone="neutral" collapsible defaultOpen>
              <DescriptionList
                layout="rows"
                size="sm"
                items={[
                  { term: t().created, description: dates.formatDateTimeRelative(createdAt(), props.dateConfig) },
                  { term: t().updated, description: dates.formatDateTimeRelative(updatedAt(), props.dateConfig) },
                  ...(lockedAt()
                    ? [
                        {
                          term: t().locked,
                          description: (
                            <span class="text-amber-600 dark:text-amber-400">
                              {dates.formatDateTimeRelative(lockedAt()!, props.dateConfig)}
                            </span>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            </DetailPanel.Section>
          </DetailPanel.Group>
        </DetailPanel.Body>
      </DetailPanel>
    </AppWorkspace.Detail>
  );
}
