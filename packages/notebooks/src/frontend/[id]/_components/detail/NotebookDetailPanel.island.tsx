import { CloudAvatar, cloudAvatarSource } from "@k2b/cloud/account/ui";
import { useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import type { NotebookPresenceParticipant } from "@k2b/cloud/contracts";
import { navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates, fileIcons, type Paginated } from "@k2b/stdlib";
import { clipboard, files } from "@k2b/stdlib/browser";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  AvatarStack,
  type AvatarStackPerson,
  Button,
  ButtonLink,
  DetailPanel,
  type DropdownItem,
  IconButton,
  ProgressBar,
  prompts,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicNoteComment } from "@/api/public-resources";
import { notebookCommandMessages } from "../../../../commands";
import type { NoteAuthors, NotebookActivityActor } from "../../../../lib/activity-actions";
import type { NamedBlockSummary } from "../../../../lib/named-blocks";
import type { PresentationMode } from "../../../../lib/presentation-mode";
import type { Backlink } from "../../../../service/links";
import { describeNoteActivity } from "../../../activity-messages";
import { openAttachment } from "../../../lib/attachment-preview";
import { buildGraphUrl, buildVersionsUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import type { Attachment } from "../editor/attachments-client";
import { formatBytes } from "../editor/attachments-client";
import { CONNECT_SETTLE_MS } from "../editor/sync-state";
import { setDetailPanelOpen } from "../settings/NotebookSettingsStore";
import { WORKSPACE_EVENT, type WorkspaceEventDetail } from "../sidebar/workspace-events";
import { useDuplicateNote } from "./duplicate-note";
import {
  ACTIVE_HEADING_EVENT,
  type ActiveHeadingEventDetail,
  ATTACHMENTS_UPDATE_EVENT,
  DETAIL_PANEL_STATE_EVENT,
  DETAIL_PANEL_TOGGLE_EVENT,
  DUPLICATE_NOTE_EVENT,
  EDITOR_COPY_EVENT,
  EDITOR_DOWNLOAD_EVENT,
  EDITOR_PDF_EVENT,
  JUMP_TO_PARTICIPANT_EVENT,
  NAMED_BLOCK_SCROLL_EVENT,
  NAMED_BLOCKS_UPDATE_EVENT,
  NOTE_SOFT_NAVIGATED_EVENT,
  NOTE_TITLE_CHANGED_EVENT,
  PRESENCE_EVENT,
  PRESENCE_LOCATIONS_EVENT,
  type PresenceLocationsEventDetail,
  RECONNECT_EVENT,
  REVEAL_COMMENT_EVENT,
  RICH_MODE_CHANGED_EVENT,
  SYNC_STATE_EVENT,
  SYNC_STATE_REQUEST_EVENT,
  type SyncStateEventDetail,
  TASKS_UPDATE_EVENT,
  TOC_SCROLL_EVENT,
  TOC_UPDATE_EVENT,
  TOGGLE_RICH_MODE_EVENT,
} from "./events";
import NoteCommentsSection from "./NoteCommentsSection";
import { openNotePdfDialog } from "./NotePdfDialog";
import { launchNotebookNoteAssistant } from "./notebook-assistant-launch";
import type { TaskProgress } from "./tasks";
import type { TocItem } from "./toc";
import { ViewMenu } from "./ViewMenu";

type Props = {
  presentationMode?: PresentationMode;
  noteAuthors?: NoteAuthors;
  mode: "edit" | "read";
  initiallyOpen: boolean;
  fullWidth: boolean;
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
  historyIncomplete: boolean;
  isLocked: boolean;
  canWrite: boolean;
  currentUserId: string;
  initialCommentsPage?: Paginated<PublicNoteComment>;
  dateConfig: DateContext;
  namedBlocks: NamedBlockSummary[];
};

type SoftNavigatedDetail = {
  noteAuthors: NoteAuthors;
  noteId: string;
  noteTitle: string;
  contentMd: string | null;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
  historyIncomplete: boolean;
  isLocked: boolean;
  tocItems: TocItem[];
  taskProgress: TaskProgress;
  attachments: Attachment[];
  backlinks: Backlink[];
  namedBlocks: NamedBlockSummary[];
};

type NoteActivityItem = {
  id: string;
  actor: NotebookActivityActor;
  action: string;
  metadata: Record<string, unknown>;
  occurrenceCount: number;
  lastOccurredAt: string;
};

/** `noteId` is the note the page was read for: while another note loads, the old note's pages are still shown. */
type ActivityPage = { data: NoteActivityItem[]; nextCursor: string | null; noteId: string };
/** The actions that change a note's text, as the server's last-editor query counts them. */
const EDIT_ACTIONS = new Set(["note.edited", "note.restored", "note.created"]);

/** Activity rows before "n more": enough to see what happened lately without pushing the panel's end away. */
const NEWEST_ACTIVITY = 4;
const ACTIVITY_PAGE_SIZE = 10;
const NO_AUTHORS: NoteAuthors = { createdBy: null, lastEditedBy: null };
const REFERENCE_ICONS: Partial<Record<NamedBlockSummary["type"], string>> = {
  table: "ti-table",
  list: "ti-list",
  data: "ti-database",
  section: "ti-section",
};

/**
 * The note's side panel: one header with who changed the note and who is here, one action row, then the sections
 * in the order people need them (comments, tasks, contents, references, attachments, links, activity). Every
 * section uses the shared `DetailPanel` rhythm; `DetailPanel.Body` remains the only scroll owner.
 *
 * Event flow (all through window CustomEvents, see `events.ts`):
 *  - editor toolbar / readonly footer → DETAIL_PANEL_TOGGLE_EVENT → toggles open
 *  - editor → TOC_UPDATE_EVENT / ACTIVE_HEADING_EVENT → outline and its current section
 *  - editor → PRESENCE_EVENT / PRESENCE_LOCATIONS_EVENT → people here and where they are
 *  - editor → SYNC_STATE_EVENT → offline state; panel → RECONNECT_EVENT retries
 *  - panel → TOC_SCROLL_EVENT / JUMP_TO_PARTICIPANT_EVENT → editor scrolls
 *  - panel → TOGGLE_RICH_MODE_EVENT → editor flips its `richMode` signal
 *  - panel → EDITOR_COPY_EVENT / EDITOR_DOWNLOAD_EVENT → editor uses its
 *    current `ytext` rather than the SSR-time `contentMd` snapshot
 *  - readonly rendering falls back to `contentMd` prop directly (no editor present)
 */
export default function NotebookDetailPanel(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const duplicateNote = useDuplicateNote(props.notebookId);
  const [open, setOpen] = createSignal(props.initiallyOpen);
  const [tocItems, setTocItems] = createSignal<TocItem[]>(props.tocItems);
  const [activeHeading, setActiveHeading] = createSignal<string | null>(null);
  const [tasks, setTasks] = createSignal<TaskProgress>(props.taskProgress);
  const [noteId, setNoteId] = createSignal(props.noteId);
  const [noteTitle, setNoteTitle] = createSignal(props.noteTitle);
  const [contentMd, setContentMd] = createSignal(props.contentMd);
  const [historyIncomplete, setHistoryIncomplete] = createSignal(props.historyIncomplete);
  const [backlinks, setBacklinks] = createSignal<Backlink[]>(props.backlinks);
  const [createdAt, setCreatedAt] = createSignal(props.createdAt);
  const [updatedAt, setUpdatedAt] = createSignal(props.updatedAt);
  const [lockedAt, setLockedAt] = createSignal(props.lockedAt);
  const [authors, setAuthors] = createSignal<NoteAuthors>(props.noteAuthors ?? NO_AUTHORS);
  const [, setIsLocked] = createSignal(props.isLocked);
  const [namedBlocks, setNamedBlocks] = createSignal<NamedBlockSummary[]>(props.namedBlocks);
  // Online until the editor says otherwise: the server rendered a connected page, and Read has no live connection.
  const [sync, setSync] = createSignal<SyncStateEventDetail>({ connected: true, lastSavedAt: null });
  const offline = () => props.mode === "edit" && !sync().connected;
  const [reconnecting, setReconnecting] = createSignal(false);
  const [activityExpanded, setActivityExpanded] = createSignal(false);

  /** What the activity read last asked for, so Retry repeats a failed refresh or a failed older page. */
  let activityRead: "fresh" | "older" = "fresh";
  const noteActivity = query.createInfinite<string, ActivityPage, string>({
    source: noteId,
    loadPage: async (currentNoteId, { cursor, abortSignal }) => {
      const response = await apiClient.overview.activity.$get(
        {
          query: {
            notebook: props.notebookId,
            note: currentNoteId,
            limit: String(ACTIVITY_PAGE_SIZE),
            ...(cursor ? { cursor } : {}),
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t().loadActivityFailed);
      const page = (await response.json()) as Omit<ActivityPage, "noteId">;
      return { ...page, noteId: currentNoteId };
    },
    getNextCursor: (page) => page.nextCursor,
    // A comment or a saved change of this note adds to its log, so the log reads again, like the comments do.
    subscribe: ({ invalidate }) => {
      const onWorkspaceEvent = (raw: Event) => {
        const { event, cover } = (raw as CustomEvent<WorkspaceEventDetail>).detail;
        const changed =
          (event.type === "note.comments.changed" && event.noteId === noteId()) ||
          (event.type === "note.updated" && event.note.id === noteId());
        if (!changed || event.notebookId !== props.notebookId) return;
        activityRead = "fresh";
        cover(invalidate());
      };
      window.addEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
      return () => window.removeEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
    },
  });
  // Creation is always the last row and comes from the note itself, so it is not repeated from the log.
  const activityItems = createMemo(() =>
    noteActivity
      .pages()
      .flatMap((page) => page.data)
      .filter((item) => item.action !== "note.created"),
  );
  /**
   * The newest edit seen in the log for this note, which a refresh keeps current when someone else saves. It stays
   * when later comments push it off the first page; the server's snapshot covers the time before the log loads.
   */
  const seenEdit = createMemo<{ noteId: string; item: NoteActivityItem | undefined }>(
    (previous) => {
      const id = noteId();
      const kept = previous.noteId === id ? previous.item : undefined;
      const first = noteActivity.pages()[0];
      const onPage = first?.noteId === id ? first.data.find((item) => EDIT_ACTIONS.has(item.action)) : undefined;
      const newer = onPage && (!kept || Date.parse(onPage.lastOccurredAt) >= Date.parse(kept.lastOccurredAt));
      return { noteId: id, item: newer ? onPage : kept };
    },
    { noteId: noteId(), item: undefined },
  );
  const newestEdit = () => seenEdit().item;
  const lastEditor = () => newestEdit()?.actor ?? authors().lastEditedBy;
  const editedAt = () => {
    const logged = newestEdit()?.lastOccurredAt;
    return logged && Date.parse(logged) > Date.parse(updatedAt()) ? logged : updatedAt();
  };
  const visibleActivity = () => (activityExpanded() ? activityItems() : activityItems().slice(0, NEWEST_ACTIVITY));
  const hiddenActivity = () => Math.max(0, activityItems().length - NEWEST_ACTIVITY);

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
  const [locations, setLocations] = createSignal<PresenceLocationsEventDetail>({});
  // Mirrors the editor's richMode signal — kept in sync via window events.
  // Default `true` matches the editor's initial state, so SSR and the first
  // client render agree even if the editor's broadcast hasn't arrived yet.
  const [isRich, setIsRich] = createSignal(true);
  const editWithAi = mutations.create<void, void>({
    mutation: async () => {
      const launch = await launchNotebookNoteAssistant({
        notebookId: props.notebookId,
        noteId: noteId(),
        noteTitle: noteTitle(),
      });
      navigateTo(launch.href);
    },
    onError: (error) => prompts.error(error.message || t().assistantLaunchFailed),
  });

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

  const exportContent = () =>
    historyIncomplete()
      ? `> **${t().historyIncompleteTitle}** ${t().historyIncompleteDetail}\n\n${contentMd() ?? ""}`
      : (contentMd() ?? "");

  const copyContent = () => {
    if (props.mode === "edit") {
      window.dispatchEvent(new CustomEvent(EDITOR_COPY_EVENT));
    } else {
      void clipboard.copy(exportContent()).then(
        () => toast.success(t().contentCopied),
        () => toast.error(t().contentCopyFailed),
      );
    }
  };

  const downloadContent = () => {
    if (props.mode === "edit") {
      window.dispatchEvent(new CustomEvent(EDITOR_DOWNLOAD_EVENT));
    } else {
      files.downloadFileFromContent(exportContent(), downloadFilename(), "text/markdown");
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
      openPdf(exportContent());
    }
  };

  const canEditWithAi = () => props.mode === "edit" && props.canWrite && !lockedAt();

  createEffect(() => {
    const id = noteId();
    if (!id) return;
    const title = noteTitle() || t().untitled;
    const copy = notebookCommandMessages.resolve([locale()]).t;
    onCleanup(
      registerContextAwareCommand({
        scope: "selection",
        id: `notebooks.${id}.markdown`,
        title: t().downloadNoteMarkdown,
        description: copy.markdownDescription({ title }),
        icon: "ti ti-markdown",
        action: downloadContent,
      }),
    );
    onCleanup(
      registerContextAwareCommand({
        scope: "selection",
        id: `notebooks.${id}.pdf`,
        title: t().downloadNotePdf,
        description: copy.pdfDescription({ title }),
        icon: "ti ti-file-type-pdf",
        action: downloadPdf,
      }),
    );
    if (canEditWithAi() && !offline() && !editWithAi.loading())
      onCleanup(
        registerContextAwareCommand({
          scope: "selection",
          id: `notebooks.${id}.ai`,
          title: t().editWithAi,
          description: copy.aiDescription({ title }),
          icon: "ti ti-sparkles",
          action: async () => {
            await editWithAi.mutate();
          },
        }),
      );
  });

  const onTocItemClick = (event: MouseEvent, id: string) => {
    if (props.mode === "read") return;
    event.preventDefault();
    window.dispatchEvent(new CustomEvent(TOC_SCROLL_EVENT, { detail: { id } }));
  };

  const scrollToNamedBlock = (block: NamedBlockSummary) => {
    window.dispatchEvent(new CustomEvent(NAMED_BLOCK_SCROLL_EVENT, { detail: block }));
  };

  // A manual attempt shows its progress until the connection is back or the attempt had time to fail, so the
  // button never stays busy after a failed try.
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const reconnect = () => {
    setReconnecting(true);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => setReconnecting(false), CONNECT_SETTLE_MS);
    window.dispatchEvent(new CustomEvent(RECONNECT_EVENT));
  };
  createEffect(() => {
    if (sync().connected) {
      clearTimeout(reconnectTimer);
      setReconnecting(false);
    }
  });
  onCleanup(() => clearTimeout(reconnectTimer));

  onMount(() => {
    const onDuplicate = (event: Event) => {
      const detail = (event as CustomEvent<{ noteId: string }>).detail;
      if (props.canWrite && detail?.noteId === noteId()) void duplicateNote.duplicate(detail.noteId);
    };
    window.addEventListener(DUPLICATE_NOTE_EVENT, onDuplicate);
    onCleanup(() => window.removeEventListener(DUPLICATE_NOTE_EVENT, onDuplicate));
    const onTocUpdate = (event: Event) => {
      const detail = (event as CustomEvent<TocItem[]>).detail;
      if (Array.isArray(detail)) setTocItems(detail);
    };
    const onActiveHeading = (event: Event) => {
      const detail = (event as CustomEvent<ActiveHeadingEventDetail>).detail;
      if (detail && "id" in detail) setActiveHeading(detail.id);
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
    const onLocations = (event: Event) => {
      const detail = (event as CustomEvent<PresenceLocationsEventDetail>).detail;
      if (detail && typeof detail === "object") setLocations(detail);
    };
    const onSyncState = (event: Event) => {
      const detail = (event as CustomEvent<SyncStateEventDetail>).detail;
      if (detail && typeof detail.connected === "boolean") setSync(detail);
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
      setHistoryIncomplete(detail.historyIncomplete);
      setCreatedAt(detail.createdAt);
      setUpdatedAt(detail.updatedAt);
      setLockedAt(detail.lockedAt);
      setIsLocked(detail.isLocked);
      setAuthors(detail.noteAuthors ?? NO_AUTHORS);
      setTocItems(detail.tocItems);
      setActiveHeading(null);
      setTasks(detail.taskProgress);
      setBacklinks(detail.backlinks);
      setActivityExpanded(false);
      const ids = detail.attachments.map((attachment) => attachment.id);
      setAttachmentSnapshot({ source: buildAttachmentSource(detail.noteId, ids), attachments: detail.attachments });
      setAttachmentRoute({ noteId: detail.noteId, ids });
      setNamedBlocks(detail.namedBlocks);
    };
    const onTitleChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ noteId?: string; title?: string }>).detail;
      if (detail?.noteId === noteId() && detail.title) setNoteTitle(detail.title);
    };
    const onWorkspaceEvent = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceEventDetail>).detail?.event;
      if (detail?.type === "note.updated" && detail.note.id === noteId() && detail.note.historyIncomplete === true) {
        setHistoryIncomplete(true);
      }
    };

    window.addEventListener(TOC_UPDATE_EVENT, onTocUpdate);
    window.addEventListener(ACTIVE_HEADING_EVENT, onActiveHeading);
    window.addEventListener(TASKS_UPDATE_EVENT, onTasksUpdate);
    window.addEventListener(ATTACHMENTS_UPDATE_EVENT, onAttachmentsUpdate);
    window.addEventListener(NAMED_BLOCKS_UPDATE_EVENT, onNamedBlocksUpdate);
    window.addEventListener(PRESENCE_EVENT, onPresenceUpdate);
    window.addEventListener(PRESENCE_LOCATIONS_EVENT, onLocations);
    window.addEventListener(SYNC_STATE_EVENT, onSyncState);
    window.addEventListener(DETAIL_PANEL_TOGGLE_EVENT, onToggle);
    window.addEventListener(RICH_MODE_CHANGED_EVENT, onRichChange);
    window.addEventListener(NOTE_SOFT_NAVIGATED_EVENT, onSoftNavigated);
    window.addEventListener(NOTE_TITLE_CHANGED_EVENT, onTitleChanged);
    window.addEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
    // The editor may have mounted first; ask it for the current state.
    window.dispatchEvent(new CustomEvent(SYNC_STATE_REQUEST_EVENT));

    onCleanup(() => {
      window.removeEventListener(TOC_UPDATE_EVENT, onTocUpdate);
      window.removeEventListener(ACTIVE_HEADING_EVENT, onActiveHeading);
      window.removeEventListener(TASKS_UPDATE_EVENT, onTasksUpdate);
      window.removeEventListener(ATTACHMENTS_UPDATE_EVENT, onAttachmentsUpdate);
      window.removeEventListener(NAMED_BLOCKS_UPDATE_EVENT, onNamedBlocksUpdate);
      window.removeEventListener(PRESENCE_EVENT, onPresenceUpdate);
      window.removeEventListener(PRESENCE_LOCATIONS_EVENT, onLocations);
      window.removeEventListener(SYNC_STATE_EVENT, onSyncState);
      window.removeEventListener(DETAIL_PANEL_TOGGLE_EVENT, onToggle);
      window.removeEventListener(RICH_MODE_CHANGED_EVENT, onRichChange);
      window.removeEventListener(NOTE_SOFT_NAVIGATED_EVENT, onSoftNavigated);
      window.removeEventListener(NOTE_TITLE_CHANGED_EVENT, onTitleChanged);
      window.removeEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
    });
  });

  // ── Derived view state ────────────────────────────────────────────────

  /** The note's title is its first H1 and already heads the panel; the outline lists what comes below it. */
  const outline = createMemo(() => {
    const items = tocItems();
    return items[0]?.level === 1 ? items.slice(1) : items;
  });
  const outlineBase = () => Math.min(...outline().map((item) => item.level));

  const exact = (value: string) => dates.formatDateTime(value, props.dateConfig);
  const relative = (value: string) => dates.formatDateTimeRelative(value, props.dateConfig);
  const isSelf = (actor: NotebookActivityActor | null | undefined) => actor?.kind === "user" && actor.id === props.currentUserId;
  const actorName = (actor: NotebookActivityActor | null | undefined) => (isSelf(actor) ? t().you : (actor?.displayName ?? ""));

  const others = createMemo(() => participants().filter((participant) => participant.userId !== props.currentUserId));
  const people = createMemo<AvatarStackPerson[]>(() =>
    participants().map((participant) => {
      const self = participant.userId === props.currentUserId;
      const location = locations()[participant.userId];
      const heading = self ? outline().find((item) => item.id === activeHeading())?.text : location?.headingText;
      const writing = !self && location?.writing === true;
      return {
        id: participant.userId,
        name: self ? t().you : participant.displayName,
        src: cloudAvatarSource(participant.userId, participant.avatarHash),
        self,
        detailIcon: self ? undefined : writing ? "ti ti-pencil" : "ti ti-eye",
        detail: self ? (heading ?? undefined) : [writing ? t().presenceWriting : t().presenceReading, heading].filter(Boolean).join(" · "),
        trailing: participant.peerCount > 1 ? t().tabs({ count: participant.peerCount }) : undefined,
        onSelect:
          !self && location?.writing
            ? () => window.dispatchEvent(new CustomEvent(JUMP_TO_PARTICIPANT_EVENT, { detail: { userId: participant.userId } }))
            : undefined,
      };
    }),
  );
  const presenceLabel = () => {
    const names = others().map((participant) => participant.displayName);
    return t().hereNowLabel({ names: names.slice(0, 3).join(", "), more: Math.max(0, names.length - 3) });
  };

  const cloudId = useCloudIdCopy();
  const moreItems = (): DropdownItem[] => [
    {
      items: [
        // Immediate: on a phone the clipboard and a download accept the request only during the tap.
        { label: t().copyContent, icon: "ti ti-copy", action: copyContent, immediate: true },
        { label: t().downloadAsMarkdown, icon: "ti ti-download", action: downloadContent, immediate: true },
        { label: t().exportAsPdf, icon: "ti ti-file-type-pdf", action: downloadPdf },
      ],
    },
    {
      items: [
        { label: t().versionHistory, icon: "ti ti-history", href: buildVersionsUrl(props.notebookId, noteId()) },
        { label: t().showInGraph, icon: "ti ti-affiliate", href: buildGraphUrl(props.notebookId, noteId(), props.presentationMode) },
      ],
    },
    ...(props.canWrite
      ? [
          {
            items: [
              {
                label: t().duplicate,
                icon: "ti ti-copy-plus",
                action: () => window.dispatchEvent(new CustomEvent(DUPLICATE_NOTE_EVENT, { detail: { noteId: noteId() } })),
              },
            ],
          },
        ]
      : []),
    ...cloudId.section({ type: "notebooks.note", id: noteId() }),
  ];

  const activityHref = (item: NoteActivityItem): string | undefined =>
    item.action.startsWith("comment.") ? undefined : buildVersionsUrl(props.notebookId, noteId());
  const revealComment = (item: NoteActivityItem) => {
    const commentId = typeof item.metadata.commentId === "string" ? item.metadata.commentId : null;
    window.dispatchEvent(
      new CustomEvent(REVEAL_COMMENT_EVENT, { detail: { commentId: item.action === "comment.deleted" ? null : commentId } }),
    );
  };

  // ── Pieces ────────────────────────────────────────────────────────────

  /** A relative time with its exact date on hover and keyboard focus. */
  const Time = (timeProps: { value: string; focusable?: boolean }): JSX.Element => (
    <Tooltip.Anchor content={exact(timeProps.value)} class="notebook-time">
      <time datetime={timeProps.value} tabIndex={timeProps.focusable ? 0 : undefined}>
        {relative(timeProps.value)}
      </time>
    </Tooltip.Anchor>
  );

  const ActorAvatar = (avatarProps: { actor: NotebookActivityActor | null }): JSX.Element => (
    <CloudAvatar
      username={avatarProps.actor?.displayName ?? "?"}
      userId={avatarProps.actor?.id}
      avatarHash={avatarProps.actor?.avatarHash}
      kind={avatarProps.actor?.kind}
      size="xs"
    />
  );

  /** "Jana Berger · edited 12 min ago", or the state that matters more: offline, locked, read only. */
  const metaLine = (): JSX.Element => {
    const edited = (lead: boolean) => (
      <>
        {lead ? t().editedAtStart : t().editedAt} <Time value={editedAt()} focusable />
      </>
    );
    if (offline())
      return (
        <>
          <span class="notebook-meta-state" data-tone="warning">
            <i class="ti ti-cloud-off" aria-hidden="true" /> {t().offline}
          </span>
          <Show when={sync().lastSavedAt}>
            {(savedAt) => (
              <>
                {" · "}
                {t().lastSaved} <time datetime={savedAt()}>{dates.formatTime(savedAt(), props.dateConfig)}</time>
              </>
            )}
          </Show>
        </>
      );
    if (lockedAt())
      return (
        <>
          <Tooltip.Anchor content={t().lockedSince({ time: exact(lockedAt()!) })} class="notebook-meta-state" data-tone="warning">
            <span tabIndex={0}>
              <i class="ti ti-lock" aria-hidden="true" /> {t().locked}
            </span>
          </Tooltip.Anchor>
          {" · "}
          {edited(false)}
        </>
      );
    if (!props.canWrite)
      return (
        <>
          <span class="notebook-meta-state">{t().readOnlyShort}</span>
          {" · "}
          {edited(false)}
        </>
      );
    const editor = lastEditor();
    return (
      <Show when={editor} fallback={edited(true)}>
        {(person) => (
          <>
            <span class="notebook-meta-name">{actorName(person())}</span>
            {" · "}
            {edited(false)}
          </>
        )}
      </Show>
    );
  };

  const ActivityRow = (rowProps: { item: NoteActivityItem }): JSX.Element => {
    const item = rowProps.item;
    const title = (
      <>
        <strong class="notebook-activity-name">{actorName(item.actor)}</strong>{" "}
        {describeNoteActivity(item.action, { self: isSelf(item.actor), locale: locale() })}
        <Show when={item.occurrenceCount > 1}> {t().times({ count: item.occurrenceCount })}</Show>
      </>
    );
    const shared = {
      leading: <ActorAvatar actor={item.actor} />,
      title,
      wrap: true,
      trailing: <Time value={item.lastOccurredAt} />,
    };
    const href = activityHref(item);
    return (
      <Tooltip.Anchor content={exact(item.lastOccurredAt)} class="notebook-activity-row">
        <Show when={href} fallback={<DetailPanel.Action type="button" onClick={() => revealComment(item)} {...shared} />}>
          {(link) => <DetailPanel.Action href={link()} {...shared} />}
        </Show>
      </Tooltip.Anchor>
    );
  };

  return (
    <AppWorkspace.Detail
      id="notebook-detail"
      open={open()}
      onOpen={() => {
        setOpen(true);
        setDetailPanelOpen(true);
      }}
      onClose={closePanel}
    >
      <DetailPanel class="notebook-detail-panel">
        <DetailPanel.Header
          class="notebook-detail-panel-header"
          icon={`ti ${lockedAt() ? "ti-lock" : "ti-file-text"}`}
          title={noteTitle() || t().untitled}
          subtitle={metaLine()}
          meta={
            // Only with others here and a live connection; the line keeps its height either way.
            <Show when={props.mode === "edit" && !offline() && others().length > 0}>
              <AvatarStack people={people()} title={t().hereNow} label={presenceLabel()} hint={t().hereNowHint} />
            </Show>
          }
          menu={moreItems()}
          menuLabel={t().moreActions}
          actions={
            <IconButton label={t().closeNoteDetails} tooltip={t().closeDetails} size="sm" variant="ghost" onClick={closePanel}>
              <i class="ti ti-x" aria-hidden="true" />
            </IconButton>
          }
          primaryActions={
            <div class="notebook-detail-primary">
              <nav aria-label={t().noteActionsLabel} class="notebook-detail-actions">
                <Show when={canEditWithAi()}>
                  <Show
                    when={offline()}
                    fallback={
                      <Button
                        size="sm"
                        variant="ai"
                        type="button"
                        class="notebook-detail-actions__ai"
                        loading={editWithAi.loading()}
                        disabled={editWithAi.loading()}
                        onClick={() => void editWithAi.mutate()}
                      >
                        <i class="ti ti-sparkles" aria-hidden="true" /> {t().editWithAi}
                      </Button>
                    }
                  >
                    <Tooltip.Anchor content={t().needsConnection} class="notebook-detail-actions__ai">
                      <Button size="sm" variant="ai" type="button" disabled aria-label={`${t().editWithAi}: ${t().needsConnection}`}>
                        <i class="ti ti-sparkles" aria-hidden="true" /> {t().editWithAi}
                      </Button>
                    </Tooltip.Anchor>
                  </Show>
                </Show>
                <ViewMenu
                  mode={props.mode}
                  notebookId={props.notebookId}
                  noteId={noteId()}
                  canEdit={props.canWrite && !lockedAt()}
                  isRich={isRich()}
                  onToggleRich={toggleRichMode}
                  fullWidth={props.fullWidth}
                />
              </nav>
              {/* Only a connection that will come back promises to resend; an ended session shows the editor's
                  own recovery bar instead, which this band must not contradict. */}
              <Show when={offline() && !sync().ended}>
                <div class="notebook-offline-band" role="status">
                  <i class="ti ti-alert-triangle" aria-hidden="true" />
                  <div class="notebook-offline-band__copy">
                    <strong>{t().offlineTitle}</strong>
                    <p>{t().offlineDetail}</p>
                    <Button variant="text" size="xs" class="notebook-offline-band__action" loading={reconnecting()} onClick={reconnect}>
                      <i class="ti ti-refresh" aria-hidden="true" /> {t().reconnect}
                    </Button>
                  </div>
                </div>
              </Show>
            </div>
          }
        />

        <DetailPanel.Body scrollPreserveKey="notebook-detail">
          <NoteCommentsSection
            notebookId={props.notebookId}
            noteId={noteId()}
            currentUserId={props.currentUserId}
            canWrite={props.canWrite}
            initialCommentsPage={props.initialCommentsPage}
            dateConfig={props.dateConfig}
            offline={offline()}
          />

          <Show when={tasks().total > 0}>
            <DetailPanel.Section
              title={t().tasks}
              icon="ti ti-list-check"
              class="notebook-tasks"
              meta={t().tasksDone({ done: tasks().done, total: tasks().total })}
            >
              <ProgressBar label={t().completedTasks} size="xs" value={(tasks().done / Math.max(1, tasks().total)) * 100} />
            </DetailPanel.Section>
          </Show>

          <Show when={outline().length >= 2}>
            <DetailPanel.Section title={t().contents} icon="ti ti-list" count={outline().length} collapsible defaultOpen>
              <div class="notebook-panel-rows">
                <For each={outline()}>
                  {(item) => (
                    <DetailPanel.Action
                      href={`#${item.id}`}
                      class="notebook-outline-row"
                      data-depth={Math.min(2, item.level - outlineBase())}
                      current={activeHeading() === item.id}
                      onClick={(event) => onTocItemClick(event, item.id)}
                      title={item.text || t().untitled}
                    />
                  )}
                </For>
              </div>
            </DetailPanel.Section>
          </Show>

          <Show when={namedBlocks().length > 0}>
            <DetailPanel.Section title={t().references} icon="ti ti-at" count={namedBlocks().length} collapsible defaultOpen>
              <div class="notebook-panel-rows">
                <For each={namedBlocks()}>
                  {(block) => (
                    <DetailPanel.Action
                      type="button"
                      onClick={() => scrollToNamedBlock(block)}
                      leading={<i class={`ti ${REFERENCE_ICONS[block.type] ?? "ti-at"}`} aria-hidden="true" />}
                      title={<code class="notebook-reference-name">@{block.name}</code>}
                      trailing={t().referenceType({ type: block.type })}
                    />
                  )}
                </For>
              </div>
            </DetailPanel.Section>
          </Show>

          <Show when={visibleAttachments().length > 0 || attachmentMetadata.error()}>
            <DetailPanel.Section title={t().attachments} icon="ti ti-paperclip" count={visibleAttachments().length} collapsible defaultOpen>
              <div class="notebook-panel-rows">
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
                      onClick={() => openAttachment(props.notebookId, att)}
                      leading={
                        <i
                          class={`ti ${fileIcons.getFileIcon({ name: att.filename, type: "file", mimeType: att.mimeType })}`}
                          aria-hidden="true"
                        />
                      }
                      title={att.filename}
                      trailing={formatBytes(att.sizeBytes)}
                    />
                  )}
                </For>
              </div>
            </DetailPanel.Section>
          </Show>

          <Show when={backlinks().length > 0}>
            <DetailPanel.Section title={t().linkedBy} icon="ti ti-link" count={backlinks().length} collapsible defaultOpen>
              <div class="notebook-panel-rows">
                <For each={backlinks()}>
                  {(bl) => (
                    <DetailPanel.Action
                      href={`/app/notebooks/${bl.notebookId}/notes/${bl.noteId}`}
                      leading={<i class="ti ti-file-text" aria-hidden="true" />}
                      title={bl.title || t().untitled}
                      trailing={bl.notebookId !== props.currentNotebookId ? bl.notebookName : undefined}
                    />
                  )}
                </For>
              </div>
            </DetailPanel.Section>
          </Show>

          {/* The log has no count: it is a stream, not a finite set. It loads after the first paint and is the last
              section, so nothing above it moves when it arrives. */}
          <DetailPanel.Section
            title={t().activity}
            icon="ti ti-activity"
            class="notebook-activity"
            actions={
              <ButtonLink variant="ghost" size="xs" href={buildVersionsUrl(props.notebookId, noteId())}>
                <i class="ti ti-history" aria-hidden="true" /> {t().versions}
              </ButtonLink>
            }
          >
            <div class="notebook-panel-rows" aria-busy={noteActivity.loading() ? "true" : undefined}>
              <Show when={noteActivity.loading() && activityItems().length === 0 && !noteActivity.error()}>
                <For each={[0, 1, 2, 3]}>
                  {(index) => (
                    <div class="notebook-activity-skeleton" aria-hidden="true" data-index={index}>
                      <span />
                      <span />
                      <span />
                    </div>
                  )}
                </For>
                <span class="sr-only" role="status">
                  {t().loadingActivity}
                </span>
              </Show>
              <Show when={noteActivity.error() && activityItems().length === 0}>
                <div class="notebook-activity-error" role="alert">
                  <i class="ti ti-alert-circle" aria-hidden="true" />
                  <span>{t().activityLoadShort}</span>
                  <Button variant="text" size="xs" onClick={() => void noteActivity.refresh()}>
                    {t().retry}
                  </Button>
                </div>
              </Show>
              <For each={visibleActivity()}>{(item) => <ActivityRow item={item} />}</For>
              {/* An older page that failed keeps the loaded rows and says so where "Load older" was. */}
              <Show when={noteActivity.error() && activityItems().length > 0}>
                <div class="notebook-activity-error" role="alert">
                  <i class="ti ti-alert-circle" aria-hidden="true" />
                  <span>{t().activityLoadShort}</span>
                  <Button
                    variant="text"
                    size="xs"
                    onClick={() => void (activityRead === "older" ? noteActivity.loadMore() : noteActivity.refresh())}
                  >
                    {t().retry}
                  </Button>
                </div>
              </Show>
              {/* Older pages stay reachable even when the loaded rows all fit, for example after a sparse page. */}
              <Show when={!noteActivity.error() && noteActivity.hasMore() && (activityExpanded() || hiddenActivity() === 0)}>
                <DetailPanel.Action
                  type="button"
                  leading={<i class={`ti ${noteActivity.loadingMore() ? "ti-loader-2 k2b-spin" : "ti-dots"}`} aria-hidden="true" />}
                  title={t().loadOlder}
                  disabled={noteActivity.loadingMore()}
                  onClick={() => {
                    // Loaded older rows should show, so a collapsed list opens first.
                    setActivityExpanded(true);
                    activityRead = "older";
                    void noteActivity.loadMore();
                  }}
                />
              </Show>
              <Show when={activityExpanded() || hiddenActivity() > 0}>
                <DetailPanel.Action
                  type="button"
                  aria-expanded={activityExpanded()}
                  leading={<i class={`ti ${activityExpanded() ? "ti-chevron-up" : "ti-chevron-down"}`} aria-hidden="true" />}
                  title={activityExpanded() ? t().showLess : t().showMore({ count: hiddenActivity() })}
                  onClick={() => setActivityExpanded(!activityExpanded())}
                />
              </Show>
              {/* Always last, from the note itself, so a note from before the log still shows when it began. */}
              <Tooltip.Anchor content={exact(createdAt())} class="notebook-activity-row">
                <DetailPanel.Action
                  href={buildVersionsUrl(props.notebookId, noteId())}
                  leading={
                    <Show when={authors().createdBy} fallback={<i class="ti ti-file-plus" aria-hidden="true" />}>
                      {(creator) => <ActorAvatar actor={creator()} />}
                    </Show>
                  }
                  wrap
                  title={
                    <Show when={authors().createdBy} fallback={t().createdNote}>
                      {(creator) => (
                        <>
                          <strong class="notebook-activity-name">{actorName(creator())}</strong>{" "}
                          {describeNoteActivity("note.created", { self: isSelf(creator()), locale: locale() })}
                        </>
                      )}
                    </Show>
                  }
                  trailing={<Time value={createdAt()} />}
                />
              </Tooltip.Anchor>
            </div>
          </DetailPanel.Section>
        </DetailPanel.Body>
      </DetailPanel>
    </AppWorkspace.Detail>
  );
}
