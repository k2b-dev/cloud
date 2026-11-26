import { cloudAvatarSource } from "@k2b/cloud/account/ui";
import { useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { saveFiles, saveFilesLabel } from "@k2b/cloud/browser/files";
import type { AccessMember, NotebookPresenceParticipant } from "@k2b/cloud/contracts";
import type { NamedBlockSummary } from "@k2b/editor/markdown";
import { navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates, fileIcons, type Paginated } from "@k2b/stdlib";
import { clipboard, files } from "@k2b/stdlib/browser";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  type DetailAccessEntry,
  type DetailLinkItem,
  type DetailPresencePerson,
  type DetailPresenceState,
  fileKindLabel,
  formatFileViewSize,
  useLocale,
} from "@k2b/ui";
import {
  Avatar,
  Bar,
  Button,
  Chip,
  Facts,
  Failed,
  Inline,
  Loading,
  Menu,
  type MenuEntry,
  Notice,
  Pane,
  type Person,
  Progress,
  Row,
  Section,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, For, Index, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicNoteComment } from "@/api/public-resources";
import { notebookCommandMessages } from "../../../../commands";
import type { NoteAuthors, NotebookActivityActor } from "../../../../lib/activity-actions";
import type { PresentationMode } from "../../../../lib/presentation-mode";
import type { Backlink } from "../../../../service/links";
import type { NoteDetailRelations } from "../../../../service/route-state";
import { describeNoteActivity, describeNoteActivityEntry } from "../../../activity-messages";
import { attachmentPreviewKind, openAttachment } from "../../../lib/attachment-preview";
import { buildAttachmentContentUrl } from "../../../lib/editor/attachment-url";
import { buildGraphUrl, buildNoteUrl, buildTagPageUrl, buildVersionsUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import { type Attachment, confirmAndDownload } from "../editor/attachments-client";
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
  OPEN_NOTEBOOK_SETTINGS_EVENT,
  type OpenNotebookSettingsEventDetail,
  PRESENCE_EVENT,
  PRESENCE_LOCATIONS_EVENT,
  PRESENCE_RETRY_EVENT,
  PRESENCE_STATUS_EVENT,
  type PresenceLocationsEventDetail,
  type PresenceStatusEventDetail,
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
import { useSaveAsTemplate } from "./save-as-template";
import type { TaskProgress } from "./tasks";
import type { TocItem } from "./toc";

export type NoteDetailsProps = {
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
  /** What the note links to and its tags. */
  relations: NoteDetailRelations;
  /** Whether this person may see who else has access: everyone with access of their own, never public access alone. */
  accessVisible: boolean;
  /** Whether "Manage access" leads to the notebook's access settings. */
  canManageAccess: boolean;
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
  /** The server's time, so the server and the first browser render show the same activity times. */
  now: string;
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
  relations: NoteDetailRelations;
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
const isImage = (attachment: Attachment) => attachmentPreviewKind(attachment) === "image";
/** Words read per minute for the reading time in the properties. */
const WORDS_PER_MINUTE = 200;
const countWords = (markdown: string | null) => (markdown ?? "").trim().split(/\s+/).filter(Boolean).length;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const REFERENCE_ICONS: Partial<Record<NamedBlockSummary["type"], string>> = {
  table: "ti-table",
  list: "ti-list",
  data: "ti-database",
  section: "ti-section",
};

/**
 * The note's side panel in the shared details outline: one header with who changed the note and who is here, one
 * action row, then the sections in the order people need them (comments, tasks, contents, references, attachments,
 * links), and the activity under "More about this note". `DetailPanel.Body` remains the only scroll owner.
 *
 * Event flow (all through window CustomEvents, see `events.ts`):
 *  - editor toolbar / readonly footer → DETAIL_PANEL_TOGGLE_EVENT → toggles open
 *  - editor → TOC_UPDATE_EVENT / ACTIVE_HEADING_EVENT → outline and its current section
 *  - workspace socket → PRESENCE_EVENT → people here; editor → PRESENCE_LOCATIONS_EVENT → where they are
 *  - editor → SYNC_STATE_EVENT → offline state; panel → RECONNECT_EVENT retries
 *  - panel → TOC_SCROLL_EVENT / JUMP_TO_PARTICIPANT_EVENT → editor scrolls
 *  - panel → TOGGLE_RICH_MODE_EVENT → editor flips its `richMode` signal
 *  - panel → EDITOR_COPY_EVENT / EDITOR_DOWNLOAD_EVENT → editor uses its
 *    current `ytext` rather than the SSR-time `contentMd` snapshot
 *  - readonly rendering falls back to `contentMd` prop directly (no editor present)
 */
export default function NoteDetails(props: NoteDetailsProps) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const toast = useToast();
  const duplicateNote = useDuplicateNote(props.notebookId);
  const saveAsTemplate = useSaveAsTemplate(props.notebookId);
  const [open, setOpen] = createSignal(props.initiallyOpen);
  const [tocItems, setTocItems] = createSignal<TocItem[]>(props.tocItems);
  const [activeHeading, setActiveHeading] = createSignal<string | null>(null);
  const [tasks, setTasks] = createSignal<TaskProgress>(props.taskProgress);
  const [noteId, setNoteId] = createSignal(props.noteId);
  const [noteTitle, setNoteTitle] = createSignal(props.noteTitle);
  const [contentMd, setContentMd] = createSignal(props.contentMd);
  const [historyIncomplete, setHistoryIncomplete] = createSignal(props.historyIncomplete);
  const [backlinks, setBacklinks] = createSignal<Backlink[]>(props.backlinks);
  const [relations, setRelations] = createSignal<NoteDetailRelations>(props.relations);
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
  // The short and the full list keep one order: files first, then images.
  const visibleAttachments = createMemo(() => {
    const loaded = attachmentMetadata.data();
    const attachments = loaded?.source === attachmentSource() ? loaded.attachments : [];
    return [...attachments.filter((attachment) => !isImage(attachment)), ...attachments.filter(isImage)];
  });
  const [participants, setParticipants] = createSignal<NotebookPresenceParticipant[]>([]);
  const [locations, setLocations] = createSignal<PresenceLocationsEventDetail>({});
  // Unknown until the workspace socket reports, so the server render and the first client render both show loading.
  const [presenceStatus, setPresenceStatus] = createSignal<PresenceStatusEventDetail["status"]>("connecting");
  /** The people last seen live and when, shown pale while offline. */
  const [lastLive, setLastLive] = createSignal<{ participants: NotebookPresenceParticipant[]; at: string | null }>({
    participants: [],
    at: null,
  });
  // Mirrors the editor's richMode signal — kept in sync via window events.
  // Default `true` matches the editor's initial state, so SSR and the first
  // client render agree even if the editor's broadcast hasn't arrived yet.
  const [_isRich, setIsRich] = createSignal(true);
  const editWithAi = mutations.create<void, void>({
    mutation: async () => {
      const launch = await launchNotebookNoteAssistant({
        notebookId: props.notebookId,
        noteId: noteId(),
        noteTitle: noteTitle(),
      });
      navigateTo(launch.href);
    },
    onError: (error) => void toast(error.message || t().assistantLaunchFailed, { status: "bad" }),
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

  const _toggleRichMode = () => {
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
        () => void toast(t().contentCopied, { status: "ok" }),
        () => void toast(t().contentCopyFailed, { status: "bad" }),
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

  const _onTocItemClick = (event: MouseEvent, id: string) => {
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
      if (!Array.isArray(detail)) return;
      setParticipants(detail);
      if (presenceStatus() === "live") setLastLive({ participants: detail, at: new Date().toISOString() });
    };
    const onPresenceStatus = (event: Event) => {
      const status = (event as CustomEvent<PresenceStatusEventDetail>).detail?.status;
      if (status === "connecting" || status === "live" || status === "down") setPresenceStatus(status);
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
      // The people of the previous note are not here; the new note's connection reports its own.
      if (detail.noteId !== noteId()) {
        setParticipants([]);
        setLocations({});
        setLastLive({ participants: [], at: null });
      }
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
      setRelations(detail.relations);
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
    window.addEventListener(PRESENCE_STATUS_EVENT, onPresenceStatus);
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
      window.removeEventListener(PRESENCE_STATUS_EVENT, onPresenceStatus);
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

  const presenceState = (): DetailPresenceState => {
    if (offline()) return "offline";
    const status = presenceStatus();
    return status === "live" ? "live" : status === "down" ? "unavailable" : "loading";
  };
  const shownParticipants = () => (presenceState() === "offline" ? lastLive().participants : participants());
  const presencePeople = createMemo<DetailPresencePerson[]>(() =>
    shownParticipants().map((participant) => {
      const self = participant.userId === props.currentUserId;
      const location = locations()[participant.userId];
      const writing = !self && location?.writing === true;
      const place = self ? outline().find((item) => item.id === activeHeading())?.text : location?.headingText;
      return {
        id: participant.userId,
        name: participant.displayName,
        shortName: firstName(participant.displayName),
        src: cloudAvatarSource(participant.userId, participant.avatarHash),
        color: participant.color,
        activity: writing ? "writing" : "reading",
        place: place ?? undefined,
        self,
        trailing: participant.peerCount > 1 ? t().tabs({ count: participant.peerCount }) : undefined,
        onSelect: writing
          ? () => window.dispatchEvent(new CustomEvent(JUMP_TO_PARTICIPANT_EVENT, { detail: { userId: participant.userId } }))
          : undefined,
      };
    }),
  );
  /** Who writes under each heading, for the outline's fixed presence slot. */
  const writersByHeading = createMemo(() => {
    const byHeading = new Map<string, DetailPresencePerson[]>();
    if (presenceState() !== "live") return byHeading;
    for (const person of presencePeople()) {
      const headingId = locations()[person.id]?.headingId;
      if (person.self || person.activity !== "writing" || !headingId) continue;
      byHeading.set(headingId, [...(byHeading.get(headingId) ?? []), person]);
    }
    return byHeading;
  });
  const copyNoteLink = () =>
    void clipboard.copy(new URL(buildNoteUrl(props.notebookId, noteId()), window.location.origin).href).then(
      () => void toast(t().noteLinkCopied, { status: "ok" }),
      () => void toast(t().noteLinkCopyFailed, { status: "bad" }),
    );

  // Who has access loads after the first paint, once per page: it covers the whole notebook, not one note, and its
  // closed summary names the first people.
  const [access, setAccess] = createSignal<{ state: "idle" | "loading" | "ready" | "error"; members: AccessMember[] }>({
    state: "idle",
    members: [],
  });
  let accessAbort: AbortController | undefined;
  const loadAccess = async () => {
    accessAbort?.abort();
    const request = new AbortController();
    accessAbort = request;
    setAccess((previous) => ({ state: "loading", members: previous.members }));
    try {
      const response = await apiClient[":id"].access.members.$get(
        { param: { id: props.notebookId } },
        { init: { signal: request.signal } },
      );
      if (!response.ok) throw new Error(String(response.status));
      const members = await response.json();
      if (!request.signal.aborted) setAccess({ state: "ready", members });
    } catch {
      if (!request.signal.aborted) setAccess((previous) => ({ state: "error", members: previous.members }));
    }
  };
  onMount(() => {
    if (props.accessVisible) void loadAccess();
  });
  onCleanup(() => accessAbort?.abort());
  const roleLabel = (permission: AccessMember["permission"]) =>
    permission === "admin" ? t().roleAdmin : permission === "write" ? t().roleWrite : t().roleRead;
  const accessEntries = createMemo<DetailAccessEntry[]>(() =>
    access()
      .members.filter((member) => member.permission !== "none")
      .map((member, index) => {
        const principal = member.principal;
        const role = roleLabel(member.permission);
        if (principal.type === "user")
          return {
            id: `user:${principal.userId}`,
            name: member.displayName ?? "?",
            kind: "person",
            src: cloudAvatarSource(principal.userId, member.avatarHash),
            role,
            self: principal.userId === props.currentUserId,
          };
        if (principal.type === "group") return { id: `group:${principal.groupId}`, name: member.displayName ?? "?", kind: "group", role };
        if (principal.type === "service_account")
          return {
            id: `service:${principal.serviceAccountId}`,
            name: member.displayName ?? "?",
            kind: "service",
            detail: t().serviceAccount,
            role,
          };
        if (principal.type === "authenticated") return { id: `everyone:${index}`, name: t().everyoneSignedIn, kind: "everyone", role };
        return { id: `public:${index}`, name: t().publicAccess, kind: "public", role };
      }),
  );

  const linkItem = (link: Backlink): DetailLinkItem => ({
    id: `${link.notebookId}:${link.noteId}`,
    title: link.title || t().untitled,
    href: `/app/notebooks/${link.notebookId}/notes/${link.noteId}`,
    trailing: link.notebookId !== props.currentNotebookId ? link.notebookName : undefined,
  });

  const words = () => countWords(contentMd());
  const cloudId = useCloudIdCopy();
  const activityHref = (item: NoteActivityItem): string | undefined =>
    item.action.startsWith("comment.") ? undefined : buildVersionsUrl(props.notebookId, noteId());
  const revealComment = (item: NoteActivityItem) => {
    const commentId = typeof item.metadata.commentId === "string" ? item.metadata.commentId : null;
    window.dispatchEvent(
      new CustomEvent(REVEAL_COMMENT_EVENT, { detail: { commentId: item.action === "comment.deleted" ? null : commentId } }),
    );
  };

  const attachmentHref = (attachment: Attachment) => buildAttachmentContentUrl(props.notebookId, attachment.id);

  /** The closed activity's one line: its newest entry, the note's creation, or why new entries are missing. */
  const _activitySummary = () => {
    if (noteActivity.error() && activityItems().length === 0) return t().activityLoadShort;
    const newest = activityItems()[0];
    if (newest)
      return `${actorName(newest.actor)} ${describeNoteActivity(newest.action, { self: isSelf(newest.actor), locale: locale() })}`;
    if (noteActivity.loading()) return undefined;
    const creator = authors().createdBy;
    return creator
      ? `${actorName(creator)} ${describeNoteActivity("note.created", { self: isSelf(creator), locale: locale() })}`
      : t().createdNote;
  };

  /** Every entry is loaded and shown, so the timeline reaches its start: the note's creation. */
  const activityComplete = () => !noteActivity.hasMore() && (activityExpanded() || hiddenActivity() === 0);
  const retryActivity = () => void (activityRead === "older" ? noteActivity.loadMore() : noteActivity.refresh());

  // ── Drawing (v2) ──────────────────────────────────────────────────────

  /** "Jana Berger · bearbeitet vor 12 Min.", or the state that matters more: offline, locked, read only. */
  const metaText = (): string => {
    const edited = `${t().editedAt} ${relative(editedAt())}`;
    if (offline()) {
      const savedAt = sync().lastSavedAt;
      return savedAt ? `${t().offline} · ${t().lastSaved} ${dates.formatTime(savedAt, props.dateConfig)}` : t().offline;
    }
    const locked = lockedAt();
    if (locked) return `${t().locked} · ${edited}`;
    if (!props.canWrite) return `${t().readOnlyShort} · ${edited}`;
    const editor = lastEditor();
    return editor ? `${actorName(editor)} · ${edited}` : `${t().editedAtStart} ${relative(editedAt())}`;
  };
  const person = (actor: NotebookActivityActor | null | undefined): Person => ({
    name: actor?.kind === "system" || !actor ? t().automatic : actor.displayName,
    image:
      actor?.kind === "user" && actor.id && actor.avatarHash
        ? `/api/accounts/users/${encodeURIComponent(actor.id)}/avatar?rev=${encodeURIComponent(actor.avatarHash)}`
        : undefined,
  });
  const moreMenu = (): MenuEntry[] => [
    // Immediate: on a phone the clipboard and a download accept the request only during the tap.
    { label: t().copyContent, icon: "copy", onClick: copyContent },
    { label: t().downloadAsMarkdown, icon: "download", onClick: downloadContent },
    { label: t().exportAsPdf, icon: "file-type-pdf", onClick: downloadPdf },
    "separator",
    { label: t().versionHistory, icon: "history", href: buildVersionsUrl(props.notebookId, noteId()) },
    { label: t().showInGraph, icon: "affiliate", href: buildGraphUrl(props.notebookId, noteId(), props.presentationMode) },
    ...(props.canWrite
      ? [
          "separator" as const,
          {
            label: t().duplicate,
            icon: "copy-plus",
            onClick: () => window.dispatchEvent(new CustomEvent(DUPLICATE_NOTE_EVENT, { detail: { noteId: noteId() } })),
          },
          { label: t().saveAsTemplate, icon: "template", onClick: () => void saveAsTemplate.save({ id: noteId(), title: noteTitle() }) },
        ]
      : []),
    ...cloudId
      .section({ type: "notebooks.note", id: noteId() })
      .flatMap((group): MenuEntry[] => [
        "separator",
        ...("items" in group ? group.items : [group]).map((item) => ({ label: item.label, icon: "id", onClick: () => item.action?.() })),
      ]),
  ];
  const presenceText = () => {
    if (presenceState() === "unavailable") return t().presenceKeepsSaving;
    if (presenceState() === "offline") {
      const at = lastLive().at ?? sync().lastSavedAt;
      return at ? t().presenceOffline({ time: dates.formatTime(at, props.dateConfig) }) : t().offline;
    }
    return t().presenceAlone;
  };
  const presenceLine = (entry: DetailPresencePerson) =>
    [entry.activity === "writing" ? t().presenceWriting : t().presenceReading, entry.place, entry.trailing].filter(Boolean).join(" · ");
  const accessPerson = (entry: DetailAccessEntry): Person => ({ name: entry.name, image: entry.src ?? undefined });
  const facts = () => {
    const creator = authors().createdBy;
    const editor = lastEditor();
    const textBytes = new TextEncoder().encode(contentMd() ?? "").length;
    const attachmentBytes = visibleAttachments().reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
    return [
      { label: t().created, value: `${creator ? `${actorName(creator)} · ` : ""}${relative(createdAt())}`, hint: exact(createdAt()) },
      { label: t().edited, value: `${editor ? `${actorName(editor)} · ` : ""}${relative(editedAt())}`, hint: exact(editedAt()) },
      {
        label: t().extent,
        value: `${t().words({ count: words() })} · ${t().readingMinutes({ count: Math.max(1, Math.round(words() / WORDS_PER_MINUTE)) })}`,
      },
      {
        label: t().size,
        value: t().sizeWithAttachments({
          text: formatFileViewSize(textBytes, locale()),
          count: visibleAttachments().length,
          attachments: formatFileViewSize(attachmentBytes, locale()),
        }),
      },
    ];
  };
  const attachmentMenu = (attachment: Attachment): MenuEntry[] => [
    {
      label: t().downloadNamedAttachment({ filename: attachment.filename }),
      icon: "download",
      onClick: () => void confirmAndDownload(attachment.filename, attachmentHref(attachment)),
    },
    {
      label: saveFilesLabel(locale(), { name: attachment.filename }),
      icon: "cloud-upload",
      onClick: () => void saveFiles([{ name: attachment.filename, content: attachmentHref(attachment) }]),
    },
  ];
  const attachmentIcon = (attachment: Attachment) =>
    isImage(attachment)
      ? "photo"
      : fileIcons.getFileIcon({ name: attachment.filename, type: "file", mimeType: attachment.mimeType }).replace(/^ti-/, "");
  const headingRow = (item: TocItem) =>
    // k2b-ui gap: a Row has no indent; a sub-heading names its depth with a leading dash instead.
    `${item.level - outlineBase() > 0 ? "– ".repeat(Math.min(2, item.level - outlineBase())) : ""}${item.text || t().untitled}`;
  const scrollToHeading = (id: string) => window.dispatchEvent(new CustomEvent(TOC_SCROLL_EVENT, { detail: { id } }));

  // The details stay mounted while closed, so they follow the note through soft navigation and the toggle.
  return (
    <Show when={open()}>
    <Pane
      detail
      label={t().noteDetails}
      width={{ min: 300, default: 360 }}
      back={{ label: noteTitle() || t().untitled, href: buildNoteUrl(props.notebookId, noteId(), props.presentationMode), onNavigate: () => closePanel() }}
      scrollKey="notebook-detail"
      head={
        <Bar
          start={<Text weight="strong">{noteTitle() || t().untitled}</Text>}
          end={
            <>
              <Menu label={t().moreActions} items={moreMenu()} />
              <Button variant="ghost" icon="x" label={t().closeNoteDetails} onClick={closePanel} />
            </>
          }
        />
      }
      status={<Bar start={<Text type="meta">{metaText()}</Text>} />}
    >
      {/* Only a connection that will come back promises to resend; an ended session shows the editor's own bar. */}
      <Show when={offline() && !sync().ended}>
        <Notice
          tone="warn"
          icon="alert-triangle"
          title={t().offlineTitle}
          actions={[{ label: t().reconnect, icon: "refresh", onClick: reconnect, disabled: reconnecting() }]}
        >
          {t().offlineDetail}
        </Notice>
      </Show>
      <Show when={canEditWithAi()}>
        <Bar
          start={
            <Button
              icon="sparkles"
              busy={editWithAi.loading()}
              disabled={offline()}
              title={offline() ? t().needsConnection : undefined}
              onClick={() => void editWithAi.mutate()}
            >
              {t().editWithAi}
            </Button>
          }
        />
      </Show>

      <Section
        icon="users"
        title={t().hereNow}
        count={presencePeople().length || undefined}
        actions={[{ label: t().copyNoteLink, icon: "link", onClick: copyNoteLink }]}
      >
        <Switch>
          <Match when={presenceState() === "loading"}>
            <Loading rows={1} lines={2} />
          </Match>
          <Match when={presencePeople().length > 0}>
            <For each={presencePeople()}>
              {(entry) => (
                <Row
                  avatar={{ name: entry.name, image: entry.src ?? undefined, color: entry.color ?? undefined }}
                  lines={[entry.self ? `${entry.name} (${t().you})` : entry.name, presenceLine(entry)]}
                  onOpen={entry.onSelect}
                />
              )}
            </For>
          </Match>
        </Switch>
        <Show when={presenceState() !== "loading" && (presencePeople().length <= 1 || presenceState() !== "live")}>
          <Text type="meta" muted>
            {presenceText()}
          </Text>
        </Show>
        <Show when={presenceState() === "unavailable"}>
          <Bar
            end={
              <Button variant="text" icon="refresh" onClick={() => window.dispatchEvent(new CustomEvent(PRESENCE_RETRY_EVENT))}>
                {t().retry}
              </Button>
            }
          />
        </Show>
      </Section>

      {/* k2b-ui gap: the comment thread and its composer (rich, from @k2b/editor) keep their v1 drawing until the v2
          composer lands; they stand here unchanged. */}
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
        <Section icon="list-check" title={t().tasks}>
          <Progress value={tasks().done} of={tasks().total} label={t().tasksDone({ done: tasks().done, total: tasks().total })} />
        </Section>
      </Show>

      <Show when={outline().length >= 2}>
        <Section icon="list-tree" title={t().contents} count={outline().length}>
          {/* The editor sends a new outline after each pause in typing; rows keep their elements and take new values. */}
          <Index each={outline()}>
            {(item) => (
              <Row
                lines={[headingRow(item())]}
                current={activeHeading() === item().id}
                href={`#${item().id}`}
                onNavigate={(nav) => {
                  nav.event.preventDefault();
                  scrollToHeading(item().id);
                }}
                marks={
                  (writersByHeading().get(item().id) ?? []).length > 0 ? (
                    <For each={writersByHeading().get(item().id)}>
                      {(writer) => <Avatar name={writer.name} image={writer.src ?? undefined} color={writer.color ?? undefined} />}
                    </For>
                  ) : undefined
                }
              />
            )}
          </Index>
        </Section>
      </Show>

      <Section icon="hash" title={t().tags} count={relations().tags.length || undefined}>
        <Show
          when={relations().tags.length > 0}
          fallback={
            <Show when={props.canWrite}>
              <Text type="meta" muted>
                {t().tagsHint}
              </Text>
            </Show>
          }
        >
          <Inline>
            <For each={relations().tags}>
              {(tag) => (
                <Chip tag href={buildTagPageUrl(props.notebookId, tag, props.presentationMode)}>
                  {`#${tag}`}
                </Chip>
              )}
            </For>
          </Inline>
        </Show>
      </Section>

      <Show when={backlinks().length > 0 || relations().outgoing.length > 0}>
        <Section icon="link" title={t().noteLinks} count={backlinks().length + relations().outgoing.length}>
          <For each={backlinks().map(linkItem)}>
            {(link) => (
              <Row
                icon="arrow-back-up"
                lines={link.trailing ? [link.title, link.trailing] : [link.title]}
                meta={t().linkedBy}
                href={link.href}
              />
            )}
          </For>
          <For each={relations().outgoing.map(linkItem)}>
            {(link) => <Row icon="arrow-forward-up" lines={link.trailing ? [link.title, link.trailing] : [link.title]} href={link.href} />}
          </For>
        </Section>
      </Show>

      <Show when={visibleAttachments().length > 0 || attachmentMetadata.error()}>
        <Section icon="paperclip" title={t().attachments} count={visibleAttachments().length || undefined}>
          <Show
            when={!attachmentMetadata.error()}
            fallback={<Failed text={t().attachmentsLoadDescription} onRetry={() => void attachmentMetadata.refresh()} />}
          >
            {/* k2b-ui gap: a Row has no image thumbnail (Mark thumbnail #4208); an image shows its kind's symbol. */}
            <For each={visibleAttachments()}>
              {(attachment) => (
                <Menu.Context items={attachmentMenu(attachment)}>
                  <Row
                    icon={attachmentIcon(attachment)}
                    lines={[
                      attachment.filename,
                      `${fileKindLabel({ name: attachment.filename, mediaType: attachment.mimeType }, locale())} · ${formatFileViewSize(attachment.sizeBytes, locale())}`,
                    ]}
                    onOpen={() => openAttachment(props.notebookId, attachment, visibleAttachments())}
                    end={<Menu label={t().attachmentActions({ filename: attachment.filename })} items={attachmentMenu(attachment)} />}
                  />
                </Menu.Context>
              )}
            </For>
          </Show>
        </Section>
      </Show>

      <Show when={namedBlocks().length > 0}>
        <Section icon="at" title={t().references} count={namedBlocks().length}>
          <Index each={namedBlocks()}>
            {(block) => (
              <Row
                icon={(REFERENCE_ICONS[block().type] ?? "ti-at").replace(/^ti-/, "")}
                lines={[`@${block().name}`]}
                meta={t().referenceType({ type: block().type })}
                onOpen={() => scrollToNamedBlock(block())}
              />
            )}
          </Index>
        </Section>
      </Show>

      {/* Read-only for everyone with access of their own; public-link readers never get the list. */}
      <Show when={props.accessVisible}>
        <Section
          icon="lock-access"
          title={t().access}
          summary={t().accessWholeNotebook}
          actions={
            props.canManageAccess
              ? [
                  {
                    label: t().manageAccess,
                    onClick: () =>
                      window.dispatchEvent(
                        new CustomEvent<OpenNotebookSettingsEventDetail>(OPEN_NOTEBOOK_SETTINGS_EVENT, { detail: { tab: "access" } }),
                      ),
                  },
                ]
              : undefined
          }
        >
          <Switch>
            <Match when={access().state === "error"}>
              <Failed text={t().accessLoadFailed} onRetry={() => void loadAccess()} />
            </Match>
            <Match when={access().state !== "ready"}>
              <Loading rows={2} lines={2} />
            </Match>
            <Match when={true}>
              <For each={accessEntries()}>
                {(entry) => (
                  <Row avatar={accessPerson(entry)} lines={[entry.name, entry.detail ? `${entry.role} · ${entry.detail}` : entry.role]} />
                )}
              </For>
            </Match>
          </Switch>
        </Section>
      </Show>

      <Section
        icon="info-circle"
        title={t().moreAboutNote}
        more={{ label: t().openVersionHistory, href: buildVersionsUrl(props.notebookId, noteId()) }}
      >
        <Facts items={facts()} />
      </Section>

      {/* The log loads after the first paint and is the last section, so nothing above it moves when it arrives. */}
      <Section
        icon="activity"
        title={t().activity}
        more={
          !noteActivity.error() && noteActivity.hasMore() && (activityExpanded() || hiddenActivity() === 0)
            ? {
                label: t().loadOlder,
                onClick: () => {
                  setActivityExpanded(true);
                  activityRead = "older";
                  void noteActivity.loadMore();
                },
              }
            : activityExpanded() || hiddenActivity() > 0
              ? {
                  label: activityExpanded() ? t().showLess : t().showMore({ count: hiddenActivity() }),
                  onClick: () => setActivityExpanded(!activityExpanded()),
                }
              : undefined
        }
      >
        <Show when={noteActivity.error() && activityItems().length === 0}>
          <Failed text={t().activityLoadShort} onRetry={retryActivity} />
        </Show>
        <Show
          when={!noteActivity.loading() || activityItems().length > 0 || noteActivity.error()}
          fallback={<Loading rows={3} lines={2} />}
        >
          <For each={visibleActivity()}>
            {(item) => (
              <Row
                avatar={person(item.actor)}
                lines={[
                  person(item.actor).name,
                  `${describeNoteActivityEntry(item.action, locale())}${item.occurrenceCount > 1 ? ` ${t().times({ count: item.occurrenceCount })}` : ""}`,
                ]}
                time={relative(item.lastOccurredAt)}
                href={activityHref(item)}
                onOpen={activityHref(item) ? undefined : () => revealComment(item)}
              />
            )}
          </For>
          <Show when={activityComplete()}>
            <Row
              avatar={person(authors().createdBy)}
              lines={[person(authors().createdBy).name, t().createdNote]}
              time={relative(createdAt())}
              href={buildVersionsUrl(props.notebookId, noteId())}
            />
          </Show>
        </Show>
        <Show when={noteActivity.error() && activityItems().length > 0}>
          <Notice tone="bad" actions={[{ label: t().retry, onClick: retryActivity }]}>
            {t().activityLoadShort}
          </Notice>
        </Show>
      </Section>
    </Pane>
    </Show>
  );
}
