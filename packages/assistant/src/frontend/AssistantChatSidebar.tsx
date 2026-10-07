import type { AiConversationSource, AiFileStat, AiProject, AiProjectFile, AiChatTaskView as AssistantChatTask } from "@k2b/cloud/ai";
import { type ConversationFileSource, conversationFileSource } from "@k2b/cloud/ai/solid";
import {
  BottomSheet,
  Button,
  ButtonLink,
  bottomSheetOptions,
  DetailPanel,
  Dropdown,
  type DropdownItem,
  dialogCore,
  formatFileViewSize,
  IconButton,
  Lightbox,
  type LightboxImage,
  Placeholder,
  prompts,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import {
  type Accessor,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { assistantApi } from "../api/client";
import type { AssistantChatContextSnapshot, AssistantChatResult } from "../chat-context";
import type { AssistantProjectContextSnapshot } from "../project-context";
import {
  confirmOpenAssistantLink,
  loadAssistantContextImages,
  openAssistantCloudReference,
  openAssistantKnowledgeSearch,
  openAssistantMarkdown,
} from "./AssistantContextContent";
import { assistantTaskTitle, formatAssistantTaskSchedule } from "./AssistantTasksDialog";
import { assistantResourceTypeLabel } from "./assistant-context";
import { type ChatSidebarCopy, chatSidebarMessages } from "./chat-sidebar-messages";
import {
  buildFilesModel,
  buildResultsModel,
  buildSourceEntries,
  buildWorkingModel,
  type FileKind,
  fileKind,
  groupByTime,
  matchChatSearch,
  RESULT_CARD_LIMIT,
  resultsInFolder,
  SOURCE_PREVIEW_LIMIT,
  type SourceEntry,
  type TimeGroup,
  type WorkingGroup,
} from "./chat-sidebar-model";
import { formatDictationTimestamp } from "./dictation-files";
import { useAssistantCopy, useAssistantText } from "./ui-copy";

/** Where a result came from in the chat: the message that holds its delivering call. */
export type ChatSidebarJump = { messageSeq: number; callId: string | null; presentationId?: string | null };

export type ChatSidebarActions = {
  onOpenFile: (file: { path: string; title: string }) => void;
  onOpenApp: (id: string, title: string) => void;
  onJump: (target: ChatSidebarJump) => void;
  onOpenStudio?: () => void;
  onOpenSecrets?: () => void;
  onOpenTask?: (task: AssistantChatTask) => void;
  onOpenKnowledge?: () => void;
  onOpenReferences?: () => void;
  /** Opens a shared Project file, read-only here. */
  onOpenProjectFile?: (file: AiProjectFile) => void;
  onFileDeleted?: (file: { conversationId: string; path: string }) => void;
};

/** The live chat snapshot with the controls the sidebar needs; see `createAssistantChatContextState`. */
export type ChatSidebarState = {
  snapshot: Accessor<AssistantChatContextSnapshot | null>;
  projectContext: Accessor<AssistantProjectContextSnapshot | null>;
  error: Accessor<Error | null | undefined>;
  refresh: () => Promise<void>;
};

const useSidebarCopy = () => {
  const locale = useLocale();
  return () => chatSidebarMessages.resolve([locale()]).t;
};

/** The primary control of a focusable row. */
const ROW_ACTION = ":is(a, button).k2b-detail-panel__action";

const kindIcon: Record<FileKind, string> = {
  html: "ti ti-file-type-html",
  image: "ti ti-photo",
  table: "ti ti-table",
  pdf: "ti ti-file-type-pdf",
  script: "ti ti-file-code",
  text: "ti ti-file-text",
  other: "ti ti-file",
};

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const extension = (path: string) => {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
};

const kindLabel = (copy: ChatSidebarCopy, kind: FileKind, count: number) =>
  ({
    html: copy.kindHtml,
    image: copy.kindImage,
    table: copy.kindTable,
    pdf: copy.kindPdf,
    script: copy.kindScript,
    text: copy.kindText,
    other: copy.kindOther,
  })[kind]({ count });

/** "Today", "Yesterday", "Monday, Oct 5", or "September 2026"; computed from the calendar day, not the clock. */
export const timeGroupLabel = (group: Pick<TimeGroup<unknown>, "kind" | "date" | "daysAgo">, locale: string, copy: ChatSidebarCopy) => {
  if (group.kind === "day" && group.daysAgo === 0) return copy.today;
  if (group.kind === "day" && group.daysAgo === 1) return copy.yesterday;
  const [year, month, day] = group.date.split("-").map(Number) as [number, number, number?];
  const date = new Date(Date.UTC(year, month - 1, day ?? 1, 12));
  return group.kind === "day"
    ? new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long", day: "numeric", month: "short" }).format(date)
    : new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", year: "numeric" }).format(date);
};

/** A disclosure row inside a section: a group that opens in place, its contents only in the DOM while open. */
function Disclosure(props: {
  title: JSX.Element;
  count?: number;
  description?: JSX.Element;
  icon?: string;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  menuItems?: readonly DropdownItem[];
  menuLabel?: string;
  children: JSX.Element;
}) {
  const [localOpen, setLocalOpen] = createSignal(false);
  const open = () => props.open ?? localOpen();
  const id = `assistant-sidebar-group-${createUniqueId()}`;
  const toggle = () => {
    const next = !open();
    setLocalOpen(next);
    props.onToggle?.(next);
  };
  return (
    <div class="assistant-sidebar-group" data-open={open() ? "true" : undefined}>
      <div class="assistant-sidebar-group__row">
        <Button
          variant="ghost"
          size="sm"
          align="start"
          class="assistant-sidebar-group__toggle"
          aria-expanded={open()}
          aria-controls={id}
          onClick={toggle}
        >
          <i class={`ti ${open() ? "ti-chevron-down" : "ti-chevron-right"} assistant-sidebar-group__chevron`} aria-hidden="true" />
          <Show when={props.icon}>{(icon) => <i class={`${icon()} assistant-sidebar-group__icon`} aria-hidden="true" />}</Show>
          <span class="assistant-sidebar-group__copy">
            <span class="assistant-sidebar-group__title">
              {props.title}
              <Show when={props.count !== undefined}>
                <span class="assistant-sidebar-count"> · {props.count}</span>
              </Show>
            </span>
            <Show when={props.description}>
              <span class="assistant-sidebar-group__description">{props.description}</span>
            </Show>
          </span>
        </Button>
        <Show when={props.menuItems?.length && props.menuLabel}>
          <RowMenu items={props.menuItems!} label={props.menuLabel!} />
        </Show>
      </div>
      <Show when={open()}>
        <div id={id} class="assistant-sidebar-group__body">
          {props.children}
        </div>
      </Show>
    </div>
  );
}

/** The Dots menu of a group row, like the menu of a detail panel action row. */
function RowMenu(props: { items: readonly DropdownItem[]; label: string }) {
  return (
    <Dropdown.Root items={props.items} align="end" label={props.label} class="k2b-detail-panel__action-menu">
      <Dropdown.Trigger iconOnly size="sm" variant="ghost" label={props.label} class="k2b-detail-panel__action-menu-trigger">
        <i class="ti ti-dots" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}

/**
 * Which groups are open, by a key that outlives a snapshot. Every snapshot builds its groups anew, so a group that kept
 * its own state would close on each live update and after each deletion inside it.
 */
const createOpenGroups = () => {
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  return {
    isOpen: (key: string) => open().has(key),
    toggle: (key: string, next: boolean) =>
      setOpen((current) => {
        const updated = new Set(current);
        if (next) updated.add(key);
        else updated.delete(key);
        return updated;
      }),
  };
};

const FOLDER_PAGE = 50;

/**
 * The loaded pages of one working folder, kept across snapshots. A folder that changed other than by a deletion here
 * reloads its first page in place; until it arrived, the loaded files stay.
 */
const createFolderListing = (files: ConversationFileSource, folder: string) => {
  const [pages, setPages] = createSignal<AiFileStat[][]>([]);
  const [loading, setLoading] = createSignal(false);
  const [more, setMore] = createSignal(false);
  let known: { count: number; updatedAt: string } | null = null;
  let request = 0;
  const page = (after?: string) => files.listFiles(`/temp/${folder}/`, { limit: FOLDER_PAGE, after });
  const load = async () => {
    if (loading()) return;
    const current = ++request;
    setLoading(true);
    try {
      const next = await page(pages().at(-1)?.at(-1)?.path);
      if (current !== request) return;
      setPages((loaded) => [...loaded, next]);
      setMore(next.length === FOLDER_PAGE);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (current === request) setLoading(false);
    }
  };
  return {
    files: () => pages().flat(),
    loading,
    more,
    load,
    /** Loads an opened folder, or follows one that changed since its files were loaded. */
    sync: async (group: { count: number; updatedAt: string }) => {
      const changed = !known || known.count !== group.count || Date.parse(group.updatedAt) > Date.parse(known.updatedAt);
      known = { count: group.count, updatedAt: group.updatedAt };
      if (pages().length === 0) return load();
      if (!changed || loading()) return;
      const current = ++request;
      try {
        const first = await page();
        if (current !== request) return;
        setPages([first]);
        setMore(first.length === FOLDER_PAGE);
      } catch {
        // The loaded files stay; opening the group again retries.
      }
    },
    /** A file deleted here: the folder holds one file less and is no newer. */
    drop: (path: string) => {
      setPages((loaded) => loaded.map((files) => files.filter((file) => file.path !== path)));
      if (known) known = { ...known, count: known.count - 1 };
    },
  };
};
type FolderListing = ReturnType<typeof createFolderListing>;

function ResultMeta(props: { result: AssistantChatResult }) {
  const copy = useSidebarCopy();
  const text = () => {
    const result = props.result;
    if (result.file) return [extension(result.file.path), formatFileViewSize(result.file.size)].filter(Boolean).join(" · ");
    if (result.app)
      return [
        copy().studioApp,
        result.app.lastRun === "error" ? copy().runFailed : result.app.lastRun === "running" ? copy().runRunning : null,
      ]
        .filter(Boolean)
        .join(" · ");
    return copy().visualization;
  };
  return <span class="assistant-result__meta">{text()}</span>;
}

const resultJump = (result: AssistantChatResult): ChatSidebarJump | null =>
  result.messageSeq === null
    ? null
    : { messageSeq: result.messageSeq, callId: result.callId, presentationId: result.presentationId ?? null };

/** A result as a card: what it is, the sentence the assistant gave it, and its direct actions. The title jumps to its turn. */
function ResultCard(props: {
  result: AssistantChatResult;
  actions: ChatSidebarActions;
  files: ConversationFileSource;
  onDelete?: () => void;
}) {
  const copy = useSidebarCopy();
  const text = useAssistantText();
  const jump = () => resultJump(props.result);
  return (
    <article class="assistant-result" data-result-key={props.result.key}>
      <div class="assistant-result__head">
        <span class="assistant-result__icon" aria-hidden="true">
          <i class={props.result.file ? kindIcon[fileKind(props.result.file.mediaType, props.result.file.path)] : props.result.icon} />
        </span>
        <div class="assistant-result__heading">
          <Show when={jump()} fallback={<span class="assistant-result__title">{props.result.title}</span>}>
            {(target) => (
              <button
                type="button"
                class="assistant-result__title assistant-result__jump"
                title={copy().showInChat}
                aria-label={copy().showInChatNamed({ title: props.result.title })}
                onClick={() => props.actions.onJump(target())}
              >
                {props.result.title}
              </button>
            )}
          </Show>
          <ResultMeta result={props.result} />
        </div>
      </div>
      <Show when={props.result.description}>
        <p class="assistant-result__description">{props.result.description}</p>
      </Show>
      <div class="assistant-result__actions">
        <ResultButtons result={props.result} actions={props.actions} files={props.files} />
        <Show when={props.onDelete}>
          {(remove) => (
            <span class="assistant-result__more">
              <RowMenu
                items={[{ label: text("Delete"), icon: "ti ti-trash", variant: "danger", action: () => remove()() }]}
                label={copy().fileActions({ name: props.result.title })}
              />
            </span>
          )}
        </Show>
      </div>
    </article>
  );
}

function ResultButtons(props: { result: AssistantChatResult; actions: ChatSidebarActions; files: ConversationFileSource }) {
  const copy = useSidebarCopy();
  const copyLink = async (href: string) => {
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.href).href);
      toast.success(copy().linkCopied);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <>
      <Show when={props.result.file}>
        {(file) => (
          <>
            <Button
              size="xs"
              variant="ghost"
              aria-label={copy().openNamed({ title: props.result.title })}
              onClick={() => props.actions.onOpenFile({ path: file().path, title: props.result.title })}
            >
              <i class="ti ti-external-link" aria-hidden="true" />
              {copy().open}
            </Button>
            <ButtonLink
              size="xs"
              variant="ghost"
              href={props.files.downloadHref?.(file().path) ?? "#"}
              download={fileName(file().path)}
              aria-label={copy().downloadNamed({ title: props.result.title })}
            >
              <i class="ti ti-download" aria-hidden="true" />
              {copy().download}
            </ButtonLink>
          </>
        )}
      </Show>
      <Show when={props.result.app}>
        {(app) => (
          <>
            <Button
              size="xs"
              variant="ghost"
              aria-label={copy().openNamed({ title: props.result.title })}
              onClick={() => props.actions.onOpenApp(app().id, props.result.title)}
            >
              <i class="ti ti-external-link" aria-hidden="true" />
              {copy().open}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void copyLink(app().href)}>
              <i class="ti ti-link" aria-hidden="true" />
              {copy().copyLink}
            </Button>
          </>
        )}
      </Show>
      <Show when={!props.result.file && !props.result.app && resultJump(props.result)}>
        {(target) => (
          <Button size="xs" variant="ghost" onClick={() => props.actions.onJump(target())}>
            <i class="ti ti-arrow-back-up" aria-hidden="true" />
            {copy().showInChat}
          </Button>
        )}
      </Show>
    </>
  );
}

/** A result as one compact row: the row jumps to its turn, opening stays one click away. */
function ResultRow(props: {
  result: AssistantChatResult;
  actions: ChatSidebarActions;
  files: ConversationFileSource;
  when?: string;
  onDelete?: () => void;
}) {
  const text = useAssistantText();
  const copy = useSidebarCopy();
  const open = () => {
    const result = props.result;
    if (result.file) props.actions.onOpenFile({ path: result.file.path, title: result.title });
    else if (result.app) props.actions.onOpenApp(result.app.id, result.title);
    else {
      const target = resultJump(result);
      if (target) props.actions.onJump(target);
    }
  };
  const menu = (): DropdownItem[] => {
    const result = props.result;
    const target = resultJump(result);
    return [
      ...(result.file || result.app ? [{ label: copy().open, icon: "ti ti-external-link", action: open }] : []),
      ...(result.file
        ? [
            {
              label: copy().download,
              icon: "ti ti-download",
              action: () => {
                const href = props.files.downloadHref?.(result.file!.path);
                if (!href) return;
                const link = document.createElement("a");
                link.href = href;
                link.download = fileName(result.file!.path);
                link.click();
              },
            },
          ]
        : []),
      ...(target ? [{ label: copy().showInChat, icon: "ti ti-arrow-back-up", action: () => props.actions.onJump(target) }] : []),
      ...(props.onDelete ? [{ label: text("Delete"), icon: "ti ti-trash", variant: "danger" as const, action: props.onDelete }] : []),
    ];
  };
  const description = () =>
    [
      props.result.file
        ? [extension(props.result.file.path), formatFileViewSize(props.result.file.size)].filter(Boolean).join(" · ")
        : props.result.app
          ? copy().studioApp
          : copy().visualization,
      props.when,
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <DetailPanel.Action
      class="assistant-sidebar-row"
      leading={
        <i
          class={props.result.file ? kindIcon[fileKind(props.result.file.mediaType, props.result.file.path)] : props.result.icon}
          aria-hidden="true"
        />
      }
      title={props.result.title}
      description={description()}
      onClick={() => {
        const target = resultJump(props.result);
        if (target) props.actions.onJump(target);
        else open();
      }}
      menuItems={menu()}
      menuLabel={copy().fileActions({ name: props.result.title })}
    />
  );
}

/**
 * The content of the chat sidebar. While `frozen` is true (pointer or focus inside, or an open sheet), the results
 * keep the state the person is looking at; new results only raise the count in the heading.
 */
export function AssistantChatSidebarContent(props: {
  state: ChatSidebarState;
  actions: ChatSidebarActions;
  project?: AiProject | null;
  frozen: Accessor<boolean>;
  search: ChatSidebarSearch;
  runCount?: number;
}) {
  const copy = useSidebarCopy();
  const locale = useLocale();
  const text = useAssistantText();
  const assistantCopy = useAssistantCopy();
  const live = () => props.state.snapshot();
  const groups = createOpenGroups();
  const [held, setHeld] = createSignal<AssistantChatContextSnapshot | null>(null);
  createEffect(
    on(props.frozen, (frozen) => {
      setHeld(frozen ? untrack(live) : null);
    }),
  );
  /** What the sidebar shows: the held snapshot while frozen, never one of another chat. */
  const shown = createMemo(() => {
    const current = live();
    const kept = held();
    return kept && current && kept.chatId === current.chatId ? kept : current;
  });
  const pendingResults = createMemo(() => {
    const kept = held();
    const current = live();
    if (!kept || !current || kept.chatId !== current.chatId) return 0;
    const before = new Map(kept.results.map((result) => [result.key, result.deliveredAt]));
    return current.results.filter((result) => before.get(result.key) !== result.deliveredAt).length;
  });
  /** Anything else changed while the sidebar held its state: files, sources, tasks, or a result that went away. */
  const pendingChanges = createMemo(() => {
    const kept = held();
    const current = live();
    if (!kept || !current || kept === current || kept.chatId !== current.chatId) return false;
    const content = (snapshot: AssistantChatContextSnapshot) => JSON.stringify({ ...snapshot, now: null });
    return content(kept) !== content(current);
  });
  /** Takes over the live state; used for "New · N" and after the person's own changes. */
  const applyLatest = () => setHeld(props.frozen() ? live() : null);

  return (
    <Show
      when={shown()}
      fallback={
        <Placeholder
          state={props.state.error() ? "error" : "loading"}
          title={props.state.error() ? copy().couldNotLoad : copy().loading}
          description={props.state.error()?.message}
          action={
            props.state.error() ? (
              <Button size="sm" variant="secondary" onClick={() => void props.state.refresh()}>
                {copy().retry}
              </Button>
            ) : undefined
          }
        />
      }
    >
      {(snapshot) => {
        const files = createMemo(() => conversationFileSource("/api/ai", snapshot().chatId));
        /** A group's open state in this chat. */
        const group = (key: string) => {
          const scoped = `${snapshot().chatId}:${key}`;
          return { open: groups.isOpen(scoped), onToggle: (next: boolean) => groups.toggle(scoped, next) };
        };
        const listings = new Map<string, FolderListing>();
        const listing = (folder: string) => {
          const key = `${snapshot().chatId}:${folder}`;
          let found = listings.get(key);
          if (!found) {
            found = createFolderListing(files(), folder);
            listings.set(key, found);
          }
          return found;
        };
        const results = createMemo(() => buildResultsModel(snapshot().results, snapshot().now, snapshot().timeZone));
        const yourFiles = createMemo(() => buildFilesModel(snapshot().files, snapshot().now, snapshot().timeZone));
        const working = createMemo(() => buildWorkingModel(snapshot()));
        const groupLabel = (group: TimeGroup<unknown>) => timeGroupLabel(group, locale(), copy());
        const dayLabel = (iso: string) =>
          new Intl.DateTimeFormat(locale(), { timeZone: snapshot().timeZone, day: "numeric", month: "short" }).format(new Date(iso));
        const [workingOpen, setWorkingOpen] = createSignal(false);
        const [lightbox, setLightbox] = createSignal<{ images: LightboxImage[]; index: number } | null>(null);
        const openUpload = async (file: AiFileStat) => {
          if (!file.mediaType.startsWith("image/")) {
            props.actions.onOpenFile({ path: file.path, title: fileName(file.path) });
            return;
          }
          const images = snapshot().files.filter((entry) => entry.origin === "user" && entry.mediaType.startsWith("image/"));
          try {
            const loaded = await loadAssistantContextImages(
              images.map((entry) => ({
                id: entry.path,
                path: entry.path,
                mediaType: entry.mediaType,
                size: entry.size,
                scope: "chat" as const,
                source: files(),
              })),
            );
            setLightbox({
              images: loaded.map((entry) => entry.image),
              index: Math.max(
                0,
                loaded.findIndex((entry) => entry.file.path === file.path),
              ),
            });
          } catch (error) {
            void prompts.error(error instanceof Error ? error.message : String(error), { title: text("Could not open images") });
          }
        };
        const deleting = new Set<string>();
        /**
         * Deletes a chat file after confirmation. The refreshed list renders every row anew, so keyboard focus moves
         * to the row that took this row's place, the new last row, or the search field of an emptied list.
         */
        const deleteFile = async (file: AiFileStat, name: string, onRemoved?: (path: string) => void) => {
          const chatId = snapshot().chatId;
          if (!files().remove || deleting.has(file.path)) return;
          const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          const panel = active?.closest(".k2b-detail-panel") ?? null;
          const rowActions = () => Array.from(panel?.querySelectorAll<HTMLElement>(ROW_ACTION) ?? []);
          const focusedRow = active?.closest(".k2b-detail-panel__action-row")?.querySelector<HTMLElement>(ROW_ACTION);
          const focusIndex = focusedRow ? rowActions().indexOf(focusedRow) : -1;
          const confirmed = await prompts.confirm(assistantCopy().deleteChatFile({ name }), {
            title: text("Delete file"),
            confirmText: text("Delete"),
            variant: "danger",
          });
          if (!confirmed) return;
          const deleted = { conversationId: chatId, path: file.path };
          let failure: string | null = null;
          deleting.add(file.path);
          try {
            await files().remove!(file.path);
            // Before the reload, so a folder's loaded files already lack it and stay as they are.
            onRemoved?.(file.path);
          } catch (error) {
            failure = error instanceof Error ? error.message : text("File could not be deleted.");
          } finally {
            deleting.delete(file.path);
          }
          // Reload the canonical list either way; a file deleted elsewhere disappears too.
          await props.state.refresh();
          applyLatest();
          const current = live();
          const gone =
            failure === null ||
            (current !== null &&
              !current.files.some((entry) => entry.path === file.path) &&
              !current.working.looseFiles.some((entry) => entry.path === file.path) &&
              !file.path.startsWith("/temp/"));
          if (gone) {
            if (failure !== null) onRemoved?.(file.path);
            props.actions.onFileDeleted?.(deleted);
          } else toast.error(failure!, { title: text("Could not delete file") });
          const focused = document.activeElement;
          if (focusIndex >= 0 && (!focused || focused === document.body || !focused.isConnected)) {
            const actions = rowActions();
            (actions[focusIndex] ?? actions.at(-1) ?? panel?.querySelector<HTMLElement>("input"))?.focus();
          }
        };
        const deleteResult = (result: AssistantChatResult) => {
          const file = result.file;
          if (!file) return undefined;
          const stat: AiFileStat = { ...file, origin: "assistant", updatedAt: result.deliveredAt, version: 0 };
          return () => void deleteFile(stat, fileName(file.path));
        };
        const FileRow = (rowProps: {
          file: AiFileStat;
          name?: string;
          when?: string;
          open?: () => void;
          onRemoved?: (path: string) => void;
        }) => {
          const name = () => rowProps.name ?? fileName(rowProps.file.path);
          return (
            <DetailPanel.Action
              class="assistant-sidebar-row"
              leading={<i class={kindIcon[fileKind(rowProps.file.mediaType, rowProps.file.path)]} aria-hidden="true" />}
              title={name()}
              description={rowProps.when}
              trailing={<span class="assistant-sidebar-size">{formatFileViewSize(rowProps.file.size)}</span>}
              onClick={() => (rowProps.open ? rowProps.open() : props.actions.onOpenFile({ path: rowProps.file.path, title: name() }))}
              secondaryAction={{
                icon: "ti ti-trash",
                label: assistantCopy().deleteFileNamed({ name: name() }),
                variant: "danger",
                onClick: () => void deleteFile(rowProps.file, name(), rowProps.onRemoved),
              }}
            />
          );
        };

        // Needs attention: things that stopped and wait for the person, at the very top.
        const attention = () => [
          ...snapshot()
            .tasks.filter((task) => task.state === "needs_attention")
            .map((task) => ({
              key: `task:${task.id}`,
              label: copy().taskNeedsAttention({ title: assistantTaskTitle(task) }),
              action: props.actions.onOpenTask ? () => props.actions.onOpenTask!(task) : undefined,
            })),
          ...snapshot()
            .results.filter((result) => result.app?.lastRun === "error")
            .map((result) => ({
              key: `app:${result.key}`,
              label: copy().appRunFailed({ title: result.title }),
              action: () => props.actions.onOpenApp(result.app!.id, result.title),
            })),
        ];

        return (
          <Show
            when={!props.search.active()}
            fallback={<SidebarSearchResults snapshot={snapshot()} search={props.search} actions={props.actions} files={files()} />}
          >
            <Show when={attention().length}>
              <DetailPanel.Section title={copy().attention} icon="ti ti-alert-triangle" tone="warning">
                <For each={attention()}>
                  {(item) => (
                    <DetailPanel.Action
                      class="assistant-sidebar-row"
                      leading={<i class="ti ti-alert-circle" aria-hidden="true" />}
                      title={item.label}
                      disabled={!item.action}
                      onClick={() => item.action?.()}
                    />
                  )}
                </For>
              </DetailPanel.Section>
            </Show>

            <DetailPanel.Section
              title={copy().results}
              icon="ti ti-sparkles"
              class="assistant-sidebar-results"
              meta={
                <span class="assistant-sidebar-meta">
                  <Show when={snapshot().results.length}>
                    <span class="assistant-sidebar-count">{snapshot().results.length}</span>
                  </Show>
                  {/* Always rendered, so the heading keeps its height when new results wait. */}
                  <Button
                    size="xs"
                    variant="ghost"
                    class="assistant-sidebar-new"
                    data-pending={pendingChanges() ? "true" : undefined}
                    aria-hidden={pendingChanges() ? undefined : "true"}
                    tabIndex={pendingChanges() ? 0 : -1}
                    aria-label={pendingResults() > 0 ? copy().showNewResults({ count: pendingResults() }) : copy().showUpdates}
                    onClick={applyLatest}
                  >
                    {pendingResults() > 0 ? copy().newResults({ count: pendingResults() }) : copy().updates}
                  </Button>
                </span>
              }
            >
              <Show when={snapshot().results.length} fallback={<p class="assistant-sidebar-empty">{copy().resultsEmpty}</p>}>
                <div class="assistant-sidebar-results__list">
                  <For each={results().current}>
                    {(result, index) => (
                      <Show
                        when={index() < Math.min(results().latestCount, RESULT_CARD_LIMIT)}
                        fallback={<ResultRow result={result} actions={props.actions} files={files()} onDelete={deleteResult(result)} />}
                      >
                        <ResultCard result={result} actions={props.actions} files={files()} onDelete={deleteResult(result)} />
                      </Show>
                    )}
                  </For>
                  <Show when={results().latestOverflow.length}>
                    <Disclosure
                      title={copy().moreFromTurn({ count: results().latestOverflow.length })}
                      open={group("results:overflow").open}
                      onToggle={group("results:overflow").onToggle}
                    >
                      <For each={results().latestOverflow}>
                        {(result) => <ResultRow result={result} actions={props.actions} files={files()} onDelete={deleteResult(result)} />}
                      </For>
                    </Disclosure>
                  </Show>
                  <For each={results().older}>
                    {(older) => (
                      <Disclosure
                        title={groupLabel(older)}
                        count={older.items.length}
                        description={older.items
                          .slice(0, 2)
                          .map((result) => result.title)
                          .join(", ")}
                        open={group(`results:${older.key}`).open}
                        onToggle={group(`results:${older.key}`).onToggle}
                      >
                        <For each={older.items}>
                          {(result) => (
                            <ResultRow
                              result={result}
                              actions={props.actions}
                              files={files()}
                              onDelete={deleteResult(result)}
                              when={older.kind === "month" ? dayLabel(result.deliveredAt) : undefined}
                            />
                          )}
                        </For>
                      </Disclosure>
                    )}
                  </For>
                </div>
              </Show>
            </DetailPanel.Section>

            <Show when={yourFiles().count}>
              <DetailPanel.Section
                title={copy().yourFiles}
                icon="ti ti-upload"
                meta={<span class="assistant-sidebar-count">{yourFiles().count}</span>}
              >
                <For each={yourFiles().recent}>{(file) => <FileRow file={file} open={() => void openUpload(file)} />}</For>
                <Show when={yourFiles().olderCount}>
                  <Disclosure
                    title={copy().older}
                    count={yourFiles().olderCount}
                    open={group("files:older").open}
                    onToggle={group("files:older").onToggle}
                  >
                    <For each={yourFiles().older}>
                      {(older) => (
                        <Disclosure
                          title={groupLabel(older)}
                          count={older.items.length}
                          open={group(`files:${older.key}`).open}
                          onToggle={group(`files:${older.key}`).onToggle}
                        >
                          <For each={older.items}>
                            {(file) => (
                              <FileRow
                                file={file}
                                when={older.kind === "month" ? dayLabel(file.updatedAt) : undefined}
                                open={() => void openUpload(file)}
                              />
                            )}
                          </For>
                        </Disclosure>
                      )}
                    </For>
                  </Disclosure>
                </Show>
                <Show when={yourFiles().voice.length}>
                  <Disclosure
                    title={copy().voiceRecordings}
                    count={yourFiles().voice.length}
                    icon="ti ti-microphone"
                    open={group("files:voice").open}
                    onToggle={group("files:voice").onToggle}
                  >
                    <For each={yourFiles().voice}>
                      {(file) => <FileRow file={file} name={formatDictationTimestamp(file.dictationRecordedAt!, locale())} />}
                    </For>
                  </Disclosure>
                </Show>
              </DetailPanel.Section>
            </Show>

            <Show when={snapshot().sourceCount}>
              <SourcesSection snapshot={snapshot()} actions={props.actions} group={group} />
            </Show>

            <Show when={working().count || props.runCount}>
              <DetailPanel.Section
                collapsible
                open={workingOpen()}
                onOpenChange={setWorkingOpen}
                title={copy().workingFiles}
                icon="ti ti-archive"
                meta={<span class="assistant-sidebar-count">{working().count}</span>}
                description={[
                  working()
                    .kinds.slice(0, 3)
                    .map((entry) => kindLabel(copy(), entry.kind, entry.count))
                    .join(", ") + (working().kinds.length > 3 ? ", …" : ""),
                  working().storage.notice
                    ? copy().storage({
                        used: formatFileViewSize(working().storage.usedBytes),
                        max: formatFileViewSize(working().storage.maxBytes),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                <Show when={workingOpen()}>
                  <p class="assistant-sidebar-hint">{copy().workingHint}</p>
                  <For each={working().groups}>
                    {(timeGroup) => (
                      <div class="assistant-sidebar-timegroup">
                        <p class="assistant-sidebar-timegroup__label">{groupLabel(timeGroup)}</p>
                        <For each={timeGroup.items}>
                          {(working) => (
                            <WorkingGroupRow
                              group={working}
                              files={files()}
                              listing={working.folder === null ? null : listing(working.folder)}
                              results={working.folder === null ? [] : resultsInFolder(snapshot().results, working.folder)}
                              open={group(`working:${working.key}`).open}
                              onToggle={group(`working:${working.key}`).onToggle}
                              fileRow={(file, onRemoved) => <FileRow file={file} onRemoved={onRemoved} />}
                              onDeleted={async () => {
                                // A folder of the same name later is a new one.
                                if (working.folder !== null) listings.delete(`${snapshot().chatId}:${working.folder}`);
                                group(`working:${working.key}`).onToggle(false);
                                await props.state.refresh();
                                applyLatest();
                              }}
                            />
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                  <Show when={working().hiddenGroups}>
                    {(count) => <p class="assistant-sidebar-hint">{copy().hiddenGroups({ count: count() })}</p>}
                  </Show>
                  <Show when={props.runCount && props.actions.onOpenStudio}>
                    <DetailPanel.Action
                      class="assistant-sidebar-row"
                      leading={<i class="ti ti-terminal-2" aria-hidden="true" />}
                      title={`${copy().scriptRuns} · ${props.runCount}`}
                      onClick={() => props.actions.onOpenStudio?.()}
                    />
                  </Show>
                </Show>
              </DetailPanel.Section>
            </Show>

            <ContextSection snapshot={snapshot()} project={props.project ?? null} state={props.state} actions={props.actions} />

            <Show when={lightbox()}>
              {(state) => <Lightbox images={state().images} initialIndex={state().index} onClose={() => setLightbox(null)} />}
            </Show>
          </Show>
        );
      }}
    </Show>
  );
}

function WorkingGroupRow(props: {
  group: WorkingGroup;
  files: ConversationFileSource;
  /** The folder's loaded files; null for the group of loose working files, whose files the snapshot carries. */
  listing: FolderListing | null;
  /** Results stored in the folder, which deleting it deletes too. */
  results: readonly AssistantChatResult[];
  open: boolean;
  onToggle: (open: boolean) => void;
  fileRow: (file: AiFileStat, onRemoved: (path: string) => void) => JSX.Element;
  onDeleted: () => Promise<void>;
}) {
  const copy = useSidebarCopy();
  const text = useAssistantText();
  const name = () =>
    props.group.folder === null
      ? copy().workingOther
      : props.group.resultTitle
        ? copy().workingFor({ title: props.group.resultTitle })
        : props.group.folder;
  createEffect(
    on(
      () => [props.open, props.group.count, props.group.updatedAt] as const,
      ([open, count, updatedAt]) => {
        if (open) void props.listing?.sync({ count, updatedAt });
      },
    ),
  );
  const remove = async () => {
    const folder = props.group.folder;
    if (folder === null) return;
    const confirmed = await prompts.confirm(
      copy().deleteGroupDetail({ count: props.group.count, results: props.results.map((result) => result.title) }),
      { title: copy().deleteGroupNamed({ name: name() }), confirmText: text("Delete"), variant: "danger" },
    );
    if (!confirmed) return;
    try {
      await props.files.removeFolder(`/temp/${folder}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
    await props.onDeleted();
  };
  return (
    <Disclosure
      title={name()}
      count={props.group.count}
      description={formatFileViewSize(props.group.bytes)}
      open={props.open}
      onToggle={props.onToggle}
      menuItems={
        props.group.folder === null
          ? undefined
          : [{ label: copy().deleteGroup, icon: "ti ti-trash", variant: "danger", action: () => void remove() }]
      }
      menuLabel={copy().groupActions({ name: props.group.resultTitle ?? props.group.folder ?? copy().workingOther })}
    >
      <Show
        when={props.listing}
        fallback={
          <>
            <For each={props.group.files}>{(file) => props.fileRow(file, () => undefined)}</For>
            <Show when={props.group.count - props.group.files.length > 0}>
              <p class="assistant-sidebar-hint">{copy().moreFiles({ count: props.group.count - props.group.files.length })}</p>
            </Show>
          </>
        }
      >
        {(listing) => (
          <>
            <For each={listing().files()}>{(file) => props.fileRow(file, listing().drop)}</For>
            <Show when={listing().loading()}>
              <Placeholder state="loading" align="left" title={copy().loading} />
            </Show>
            <Show when={listing().more() && !listing().loading()}>
              <Button size="xs" variant="ghost" class="assistant-sidebar-more" onClick={() => void listing().load()}>
                {copy().showMoreFiles}
              </Button>
            </Show>
          </>
        )}
      </Show>
    </Disclosure>
  );
}

const hostOf = (href: string | null) => {
  if (!href) return "";
  try {
    return new URL(href).host;
  } catch {
    return "";
  }
};

/** Searches keep their query visible: it is what left Cloud for the search provider. */
const searchQuery = (source: AiConversationSource) => (source.title && source.key !== "web_search" ? source.title : null);

/** A group's open state, by a key that outlives the snapshot. */
type GroupState = (key: string) => { open: boolean; onToggle: (open: boolean) => void };

function SourceRow(props: { entry: SourceEntry; actions: ChatSidebarActions; group?: GroupState; when?: string }) {
  const copy = useSidebarCopy();
  const text = useAssistantText();
  const jumpItems = (source: AiConversationSource): DropdownItem[] =>
    source.sourceMessageSeq === null
      ? []
      : [
          {
            label: copy().showInChat,
            icon: "ti ti-arrow-back-up",
            action: () => props.actions.onJump({ messageSeq: source.sourceMessageSeq!, callId: source.sourceCallId }),
          },
        ];
  const cloudRow = (source: AiConversationSource, when?: string) => (
    <DetailPanel.Action
      class="assistant-sidebar-row"
      leading={<i class={source.icon || "ti ti-link"} aria-hidden="true" />}
      title={source.title}
      description={[source.ref ? assistantResourceTypeLabel(source.ref, text) : copy().cloudItems, when].filter(Boolean).join(" · ")}
      onClick={() => (source.ref ? void openAssistantCloudReference(source.title, source.ref) : undefined)}
      menuItems={jumpItems(source)}
      menuLabel={copy().fileActions({ name: source.title })}
    />
  );
  return (
    <Show
      when={props.entry.kind === "cloud" && props.entry}
      fallback={(() => {
        const entry = props.entry as Exclude<SourceEntry, { kind: "cloud" }>;
        const source = entry.source;
        return entry.kind === "search" ? (
          <DetailPanel.Action
            class="assistant-sidebar-row assistant-sidebar-row--plain"
            leading={<i class="ti ti-search" aria-hidden="true" />}
            title={searchQuery(source) ? copy().searched({ query: searchQuery(source)! }) : copy().webSearch}
            description={props.when}
            disabled={source.sourceMessageSeq === null}
            onClick={() =>
              source.sourceMessageSeq !== null && props.actions.onJump({ messageSeq: source.sourceMessageSeq, callId: source.sourceCallId })
            }
          />
        ) : (
          <DetailPanel.Action
            class="assistant-sidebar-row"
            leading={<i class="ti ti-world" aria-hidden="true" />}
            title={source.title}
            description={[hostOf(source.href), props.when].filter(Boolean).join(" · ")}
            onClick={() => (source.href ? void confirmOpenAssistantLink(source.title, source.href) : undefined)}
            menuItems={jumpItems(source)}
            menuLabel={copy().fileActions({ name: source.title })}
          />
        );
      })()}
    >
      {(entry) => (
        <Show when={entry().items.length > 1} fallback={cloudRow(entry().items[0]!, props.when)}>
          <Disclosure
            icon={entry().items[0]!.icon || "ti ti-stack-2"}
            title={
              entry().items.every((item) => item.ref?.type === entry().items[0]!.ref?.type) && entry().items[0]!.ref
                ? assistantResourceTypeLabel(entry().items[0]!.ref!, text)
                : copy().cloudItems
            }
            count={entry().items.length}
            description={props.when}
            open={props.group?.(`source:${entry().key}`).open}
            onToggle={props.group?.(`source:${entry().key}`).onToggle}
          >
            <For each={entry().items}>{(item) => cloudRow(item)}</For>
          </Disclosure>
        </Show>
      )}
    </Show>
  );
}

/**
 * The chat's sources after the snapshot's first page, loaded on request. When a new snapshot's first page ends
 * elsewhere, the loaded pages start over, so no source falls between them or shows twice.
 */
export const createChatSourcePages = (snapshot: Accessor<AssistantChatContextSnapshot | null>) => {
  const [pages, setPages] = createSignal<{ sources: AiConversationSource[]; cursor: string | null } | null>(null);
  const [loading, setLoading] = createSignal(false);
  let generation = 0;
  const boundary = createMemo(() => `${snapshot()?.chatId}\0${snapshot()?.sourceCursor}\0${snapshot()?.sourceCount}`);
  createEffect(
    on(
      boundary,
      () => {
        generation += 1;
        setPages(null);
        setLoading(false);
      },
      { defer: true },
    ),
  );
  const cursor = () => {
    const loaded = pages();
    return loaded ? loaded.cursor : (snapshot()?.sourceCursor ?? null);
  };
  /** The sources loaded after the snapshot's first page. */
  const extra = () => pages()?.sources ?? [];
  return {
    sources: () => [...(snapshot()?.sources ?? []), ...extra()],
    extra,
    /** More sources exist than are loaded. */
    more: () => Boolean(cursor()),
    loading,
    load: async () => {
      const from = cursor();
      const chatId = snapshot()?.chatId;
      if (!from || !chatId || loading()) return;
      const current = generation;
      setLoading(true);
      try {
        const page = await assistantApi.listConversationSources({
          conversationId: chatId,
          kinds: ["web", "activity", "resource"],
          observed: true,
          limit: 100,
          cursor: from,
        });
        if (current !== generation) return;
        setPages((loaded) => ({ sources: [...(loaded?.sources ?? []), ...page.sources], cursor: page.nextCursor ?? null }));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        if (current === generation) setLoading(false);
      }
    },
  };
};

function SourcesSection(props: { snapshot: AssistantChatContextSnapshot; actions: ChatSidebarActions; group: GroupState }) {
  const copy = useSidebarCopy();
  const locale = useLocale();
  const [open, setOpen] = createSignal(false);
  const [all, setAll] = createSignal(false);
  const pages = createChatSourcePages(() => props.snapshot);
  const entries = createMemo(() => buildSourceEntries(pages.sources()));
  const groups = createMemo(() => groupByTime(entries(), (entry) => entry.at, props.snapshot.now, props.snapshot.timeZone));
  return (
    <DetailPanel.Section
      collapsible
      open={open()}
      onOpenChange={setOpen}
      title={copy().sources}
      icon="ti ti-world"
      meta={<span class="assistant-sidebar-count">{props.snapshot.sourceCount}</span>}
    >
      <Show when={open()}>
        <Show
          when={all()}
          fallback={
            <>
              <For each={entries().slice(0, SOURCE_PREVIEW_LIMIT)}>
                {(entry) => <SourceRow entry={entry} actions={props.actions} group={props.group} />}
              </For>
              {/* Bundles can hold the whole first page; the older sources stay one step away. */}
              <Show when={entries().length > SOURCE_PREVIEW_LIMIT || pages.more()}>
                <Button size="xs" variant="ghost" class="assistant-sidebar-more" onClick={() => setAll(true)}>
                  {copy().all({ count: props.snapshot.sourceCount })}
                </Button>
              </Show>
            </>
          }
        >
          <For each={groups()}>
            {(group) => (
              <div class="assistant-sidebar-timegroup">
                <p class="assistant-sidebar-timegroup__label">{timeGroupLabel(group, locale(), copy())}</p>
                <For each={group.items}>{(entry) => <SourceRow entry={entry} actions={props.actions} group={props.group} />}</For>
              </div>
            )}
          </For>
          <Show when={pages.more()}>
            <Button size="xs" variant="ghost" class="assistant-sidebar-more" disabled={pages.loading()} onClick={() => void pages.load()}>
              {copy().loadMore}
            </Button>
          </Show>
        </Show>
      </Show>
    </DetailPanel.Section>
  );
}

function ContextSection(props: {
  snapshot: AssistantChatContextSnapshot;
  project: AiProject | null;
  state: ChatSidebarState;
  actions: ChatSidebarActions;
}) {
  const copy = useSidebarCopy();
  const locale = useLocale();
  const tasks = () => props.snapshot.tasks.filter((task) => task.state !== "completed");
  const projectContext = () => {
    const context = props.state.projectContext();
    return context && props.project && context.projectId === props.project.id ? context : null;
  };
  const summary = () =>
    [
      props.project ? copy().project({ name: props.project.name }) : null,
      props.snapshot.skills.length ? copy().skills({ count: props.snapshot.skills.length }) : null,
      props.snapshot.memories.length ? copy().memories({ count: props.snapshot.memories.length }) : null,
      tasks().length ? copy().tasks({ count: tasks().length }) : null,
    ]
      .filter(Boolean)
      .join(" · ") || copy().secrets;
  const Heading = (headingProps: { children: JSX.Element }) => <p class="assistant-sidebar-timegroup__label">{headingProps.children}</p>;
  const [open, setOpen] = createSignal(false);
  return (
    <DetailPanel.Section
      collapsible
      open={open()}
      onOpenChange={setOpen}
      title={copy().context}
      icon="ti ti-briefcase"
      description={summary()}
    >
      <Show when={open()}>
        <Show when={props.project}>
          {(project) => (
            <div class="assistant-sidebar-timegroup">
              <Heading>{project().name}</Heading>
              <DetailPanel.Action
                class="assistant-sidebar-row"
                leading={<i class="ti ti-adjustments-horizontal" aria-hidden="true" />}
                title={copy().projectInstructions}
                onClick={() =>
                  void openAssistantMarkdown(
                    copy().projectInstructions,
                    project().instructions || copy().noProjectInstructions,
                    "ti ti-adjustments-horizontal",
                  )
                }
              />
              <Show when={projectContext()?.knowledge.length}>
                <DetailPanel.Action
                  class="assistant-sidebar-row"
                  leading={<i class="ti ti-bulb" aria-hidden="true" />}
                  title={`${copy().projectKnowledge} · ${projectContext()!.knowledge.length}`}
                  onClick={() =>
                    props.actions.onOpenKnowledge
                      ? props.actions.onOpenKnowledge()
                      : void openAssistantKnowledgeSearch(projectContext()!.knowledge)
                  }
                />
              </Show>
              <For each={props.actions.onOpenProjectFile ? (projectContext()?.files ?? []) : []}>
                {(file) => (
                  <DetailPanel.Action
                    class="assistant-sidebar-row"
                    leading={<i class={kindIcon[fileKind(file.mediaType, file.path)]} aria-hidden="true" />}
                    title={fileName(file.path)}
                    description={formatFileViewSize(file.size)}
                    onClick={() => props.actions.onOpenProjectFile?.(file)}
                  />
                )}
              </For>
              <Show when={projectContext()?.references.length && props.actions.onOpenReferences}>
                <DetailPanel.Action
                  class="assistant-sidebar-row"
                  leading={<i class="ti ti-link" aria-hidden="true" />}
                  title={`${copy().projectReferences} · ${projectContext()!.references.length}`}
                  onClick={() => props.actions.onOpenReferences?.()}
                />
              </Show>
            </div>
          )}
        </Show>
        <Show when={props.snapshot.skills.length}>
          <div class="assistant-sidebar-timegroup">
            <Heading>{copy().skillsUsed}</Heading>
            <ul class="assistant-sidebar-list">
              <For each={props.snapshot.skills}>
                {(skill) => (
                  <li class="assistant-sidebar-static" title={skill.description}>
                    <i class="ti ti-puzzle" aria-hidden="true" />
                    <span class="assistant-sidebar-static__text">{skill.name}</span>
                    <span class="assistant-sidebar-count">{copy().skillTurns({ count: skill.turns })}</span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
        <Show when={props.snapshot.memories.length}>
          <div class="assistant-sidebar-timegroup">
            <Heading>{copy().memoriesFromChat}</Heading>
            <ul class="assistant-sidebar-list">
              <For each={props.snapshot.memories}>
                {(memory) => (
                  <li class="assistant-sidebar-static">
                    <i class="ti ti-bulb" aria-hidden="true" />
                    <span class="assistant-sidebar-static__text assistant-sidebar-static__text--clamp">{memory.content}</span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
        <Show when={tasks().length}>
          <div class="assistant-sidebar-timegroup">
            <Heading>{copy().scheduled}</Heading>
            <For each={tasks()}>
              {(task) => (
                <DetailPanel.Action
                  class="assistant-sidebar-row"
                  leading={<i class="ti ti-calendar-time" aria-hidden="true" />}
                  title={assistantTaskTitle(task)}
                  description={formatAssistantTaskSchedule(task, locale())}
                  disabled={!props.actions.onOpenTask}
                  onClick={() => props.actions.onOpenTask?.(task)}
                />
              )}
            </For>
          </div>
        </Show>
        <Show when={props.actions.onOpenSecrets}>
          <DetailPanel.Action
            class="assistant-sidebar-row"
            leading={<i class="ti ti-key" aria-hidden="true" />}
            title={copy().secrets}
            onClick={() => props.actions.onOpenSecrets?.()}
          />
        </Show>
      </Show>
    </DetailPanel.Section>
  );
}

/** Search across the chat's results, files, and sources, shared by the sidebar header and its content. */
export type ChatSidebarSearch = {
  active: Accessor<boolean>;
  query: Accessor<string>;
  setQuery: (query: string) => void;
  open: () => void;
  close: () => void;
};

export const createChatSidebarSearch = (): ChatSidebarSearch => {
  const [active, setActive] = createSignal(false);
  const [query, setQuery] = createSignal("");
  return {
    active,
    query,
    setQuery,
    open: () => setActive(true),
    close: () => {
      setActive(false);
      setQuery("");
    },
  };
};

const SEARCH_MIN_CHARS = 2;
const SEARCH_LIMIT = 50;

function SidebarSearchResults(props: {
  snapshot: AssistantChatContextSnapshot;
  search: ChatSidebarSearch;
  actions: ChatSidebarActions;
  files: ConversationFileSource;
}) {
  const copy = useSidebarCopy();
  const [debounced, setDebounced] = createSignal("");
  createEffect(() => {
    const value = props.search.query().trim();
    const timer = setTimeout(() => setDebounced(value), 200);
    onCleanup(() => clearTimeout(timer));
  });
  // Project context the chat never read with a tool belongs to Context, not to what the search finds as sources.
  const [hits] = createResource(
    () => (debounced().length >= SEARCH_MIN_CHARS ? { chatId: props.snapshot.chatId, q: debounced() } : null),
    async ({ chatId, q }) =>
      (await assistantApi.listConversationSources({ conversationId: chatId, q, limit: SEARCH_LIMIT, observed: true })).sources,
  );
  const matches = createMemo(() => matchChatSearch(props.snapshot.results, hits() ?? [], debounced()));
  const results = () => matches().results;
  const fileHits = () => matches().files;
  const sourceHits = () => buildSourceEntries(matches().sources);
  const empty = () => !hits.loading && hits() !== undefined && !results().length && !fileHits().length && !sourceHits().length;
  return (
    <>
      <Show when={debounced().length >= SEARCH_MIN_CHARS}>
        <Show when={results().length}>
          <DetailPanel.Section title={copy().results} icon="ti ti-sparkles">
            <For each={results()}>{(result) => <ResultRow result={result} actions={props.actions} files={props.files} />}</For>
          </DetailPanel.Section>
        </Show>
        <Show when={fileHits().length}>
          <DetailPanel.Section title={copy().files} icon="ti ti-files">
            <For each={fileHits()}>
              {(hit) => (
                <DetailPanel.Action
                  class="assistant-sidebar-row"
                  leading={<i class={kindIcon[fileKind(hit.mediaType ?? "", hit.path)]} aria-hidden="true" />}
                  title={hit.title}
                  description={hit.path}
                  trailing={hit.size === null ? undefined : <span class="assistant-sidebar-size">{formatFileViewSize(hit.size)}</span>}
                  onClick={() => props.actions.onOpenFile({ path: hit.path, title: hit.title })}
                />
              )}
            </For>
          </DetailPanel.Section>
        </Show>
        <Show when={sourceHits().length}>
          <DetailPanel.Section title={copy().sources} icon="ti ti-world">
            <For each={sourceHits()}>{(entry) => <SourceRow entry={entry} actions={props.actions} />}</For>
          </DetailPanel.Section>
        </Show>
        <Show when={hits.loading && !hits.latest}>
          <Placeholder state="loading" align="left" title={copy().loading} />
        </Show>
        <Show when={empty()}>
          <p class="assistant-sidebar-empty" role="status">
            {copy().noMatches({ query: debounced() })}
          </p>
        </Show>
      </Show>
    </>
  );
}

/** The search field that takes the title's place, in the same row height. `Escape` closes it. */
function SidebarSearchField(props: { search: ChatSidebarSearch; onClosed: () => void }) {
  const copy = useSidebarCopy();
  let field: HTMLDivElement | undefined;
  createEffect(() => {
    if (props.search.active()) queueMicrotask(() => field?.querySelector("input")?.focus());
  });
  return (
    <div ref={field} class="assistant-context-sidebar__search">
      <TextInput
        type="search"
        icon="ti ti-search"
        value={props.search.query}
        onValueChange={props.search.setQuery}
        aria-label={copy().searchLabel}
        placeholder={copy().search}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          props.search.close();
          props.onClosed();
        }}
      />
    </div>
  );
}

/**
 * Pointer or keyboard focus inside the sidebar: the results stay as they are while someone reads or acts on them. A
 * touch has no hover and a tap may not focus anything, so after a touch inside the reading lasts until a touch outside.
 */
const createReadingFreeze = () => {
  const [pointer, setPointer] = createSignal(false);
  const [focus, setFocus] = createSignal(false);
  let host: HTMLElement | undefined;
  /**
   * Reads focus from the document. WebKit moves focus to the body without a focusout when the focused control leaves
   * the document, as "Load more" does after the last page, so the last focus event alone can hold the sidebar forever.
   */
  const syncFocus = () => setFocus(Boolean(host?.contains(document.activeElement)));
  onMount(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && host?.contains(event.target)) return;
      setPointer(false);
      syncFocus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", syncFocus, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", syncFocus, true);
    });
  });
  return {
    frozen: () => pointer() || focus(),
    /** Ends the reading, for a sidebar that closes. */
    release: () => {
      setPointer(false);
      setFocus(false);
    },
    handlers: {
      onPointerEnter: (event: PointerEvent & { currentTarget: HTMLElement }) => {
        host = event.currentTarget;
        setPointer(true);
      },
      onPointerLeave: (event: PointerEvent) => {
        if (event.pointerType === "touch") return;
        setPointer(false);
        syncFocus();
      },
      onFocusIn: (event: FocusEvent & { currentTarget: HTMLElement }) => {
        host = event.currentTarget;
        setFocus(true);
      },
      onFocusOut: (event: FocusEvent & { currentTarget: HTMLElement }) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setFocus(false);
      },
    },
  };
};

/**
 * The sidebar as the chat's right column or as a drawer over its edge; the chat layout's CSS decides which. The close
 * button reports the presentation the CSS chose, so the host persists only the closing of the column.
 */
export function AssistantChatSidebarPanel(props: {
  id: string;
  state: ChatSidebarState;
  actions: ChatSidebarActions;
  project?: AiProject | null;
  runCount?: number;
  onClose: () => void;
  headingRef?: (element: HTMLHeadingElement) => void;
}) {
  const copy = useSidebarCopy();
  const headingId = `${props.id}-title`;
  const search = createChatSidebarSearch();
  const freeze = createReadingFreeze();
  let searchButton: HTMLButtonElement | undefined;
  return (
    <aside
      id={props.id}
      class="assistant-context-sidebar"
      aria-labelledby={headingId}
      {...freeze.handlers}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && getComputedStyle(event.currentTarget).position === "absolute") {
          event.preventDefault();
          freeze.release();
          props.onClose();
        }
      }}
    >
      <DetailPanel class="assistant-context-sidebar__panel">
        <header class="assistant-context-sidebar__header">
          <h2
            id={headingId}
            ref={props.headingRef}
            tabIndex={-1}
            class="assistant-context-sidebar__title"
            classList={{ "sr-only": search.active() }}
          >
            {copy().title}
          </h2>
          <Show when={search.active()}>
            <SidebarSearchField search={search} onClosed={() => searchButton?.focus()} />
          </Show>
          <div class="assistant-context-sidebar__actions">
            <IconButton
              ref={searchButton}
              size="sm"
              variant="ghost"
              label={search.active() ? copy().clearSearch : copy().search}
              aria-pressed={search.active()}
              onClick={() => (search.active() ? search.close() : search.open())}
            >
              <i class={search.active() ? "ti ti-x" : "ti ti-search"} aria-hidden="true" />
            </IconButton>
            <IconButton
              size="sm"
              variant="ghost"
              label={copy().close}
              aria-expanded="true"
              aria-controls={props.id}
              onClick={() => {
                freeze.release();
                props.onClose();
              }}
            >
              <i class="ti ti-layout-sidebar-right-collapse" aria-hidden="true" />
            </IconButton>
          </div>
        </header>
        <DetailPanel.Body class="assistant-context-sidebar__body">
          <AssistantChatSidebarContent
            state={props.state}
            actions={props.actions}
            project={props.project}
            frozen={freeze.frozen}
            search={search}
            runCount={props.runCount}
          />
        </DetailPanel.Body>
      </DetailPanel>
    </aside>
  );
}

/**
 * The sidebar as a bottom sheet on phones. Its Back entry closes it; an action that leaves the sheet (open, jump)
 * runs only after the sheet and its history entry are gone, so the jump's own history entry follows it.
 */
export const openAssistantChatSidebarSheet = async (props: {
  state: ChatSidebarState;
  actions: ChatSidebarActions;
  project?: AiProject | null;
  runCount?: number;
  wrap?: (children: () => JSX.Element) => JSX.Element;
}) => {
  let after: (() => void) | undefined;
  const leave =
    <A extends unknown[]>(close: () => void, run: (...args: A) => void) =>
    (...args: A) => {
      after = () => run(...args);
      close();
    };
  await dialogCore.open<void>(
    (close, context) => {
      const copy = chatSidebarMessages.resolve([document.documentElement.lang || "en"]).t;
      const search = createChatSidebarSearch();
      const dismiss = () => void context.requestDismiss();
      const actions: ChatSidebarActions = {
        ...props.actions,
        onOpenFile: leave(() => close(), props.actions.onOpenFile),
        onOpenApp: leave(() => close(), props.actions.onOpenApp),
        onJump: leave(() => close(), props.actions.onJump),
        onOpenStudio: props.actions.onOpenStudio && leave(() => close(), props.actions.onOpenStudio),
        onOpenTask: props.actions.onOpenTask && leave(() => close(), props.actions.onOpenTask),
        onOpenKnowledge: props.actions.onOpenKnowledge && leave(() => close(), props.actions.onOpenKnowledge),
        onOpenReferences: props.actions.onOpenReferences && leave(() => close(), props.actions.onOpenReferences),
        onOpenProjectFile: props.actions.onOpenProjectFile && leave(() => close(), props.actions.onOpenProjectFile),
        onOpenSecrets: props.actions.onOpenSecrets && leave(() => close(), props.actions.onOpenSecrets),
      };
      const content = () => (
        <BottomSheet onDismiss={dismiss}>
          <BottomSheet.Header
            title={copy.title}
            close={dismiss}
            actions={
              <IconButton
                size="sm"
                variant="ghost"
                label={search.active() ? copy.clearSearch : copy.search}
                aria-pressed={search.active()}
                onClick={() => (search.active() ? search.close() : search.open())}
              >
                <i class={search.active() ? "ti ti-x" : "ti ti-search"} aria-hidden="true" />
              </IconButton>
            }
          />
          <BottomSheet.Body>
            <DetailPanel class="assistant-context-sheet">
              <Show when={search.active()}>
                <SidebarSearchField search={search} onClosed={() => undefined} />
              </Show>
              <DetailPanel.Body scrollFade={false}>
                <AssistantChatSidebarContent
                  state={props.state}
                  actions={actions}
                  project={props.project}
                  frozen={() => true}
                  search={search}
                  runCount={props.runCount}
                />
              </DetailPanel.Body>
            </DetailPanel>
          </BottomSheet.Body>
        </BottomSheet>
      );
      return props.wrap ? props.wrap(content) : content();
    },
    { ...bottomSheetOptions, history: true },
  );
  after?.();
};

/** The same list as a workspace tab ("Files"), with the search field always at hand. */
export function AssistantChatSidebarTab(props: {
  state: ChatSidebarState;
  actions: ChatSidebarActions;
  project?: AiProject | null;
  runCount?: number;
}) {
  const [query, setQuery] = createSignal("");
  const search: ChatSidebarSearch = {
    active: () => query().trim().length > 0,
    query,
    setQuery,
    open: () => undefined,
    close: () => setQuery(""),
  };
  const freeze = createReadingFreeze();
  return (
    <div class="assistant-context-tab" {...freeze.handlers}>
      <DetailPanel>
        <div class="assistant-context-sidebar__header">
          <SidebarSearchField search={search} onClosed={() => undefined} />
        </div>
        <DetailPanel.Body>
          <AssistantChatSidebarContent
            state={props.state}
            actions={props.actions}
            project={props.project}
            frozen={freeze.frozen}
            search={search}
            runCount={props.runCount}
          />
        </DetailPanel.Body>
      </DetailPanel>
    </div>
  );
}
