import type { AiProject } from "@k2b/cloud/ai";
import { CLOUD_AI_VIEW_SUFFIX, isAiViewPath } from "@k2b/cloud/ai/browser";
import { conversationFileSource } from "@k2b/cloud/ai/solid";
import { CloudViewFile } from "@k2b/cloud/ai/ui";
import { SAVE_FILES_ICON, saveFiles, saveFilesLabel } from "@k2b/cloud/browser/files";
import {
  Button,
  Dropdown,
  type DropdownAction,
  type DropdownItem,
  FileView,
  formatFileViewSize,
  IconButtonLink,
  Placeholder,
  prompts,
  toast,
  useLocale,
} from "@k2b/ui";
import { Panes, type PanesItem } from "@k2b/ui/panes";
import {
  type Accessor,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  ErrorBoundary,
  getOwner,
  type JSX,
  on,
  onCleanup,
  Show,
} from "solid-js";
import type { AssistantChatContextSnapshot, AssistantChatResult } from "../chat-context";
import { AssistantChatContextContent, type ContextView } from "../frontend/AssistantChatContext";
import type { ChatSidebarJump } from "../frontend/AssistantChatSidebar";
import { dismissAssistantPanesHint } from "../frontend/chat-sidebar-layout";
import { chatSidebarMessages } from "../frontend/chat-sidebar-messages";
import { GENERIC_VIEW_ICON, viewKindMessages } from "../frontend/view-kind-messages";
import { artifactMessages } from "./messages";
import { WebReaderTab } from "./WebReaderTab";
import type { ChatWorkspaceController } from "./workspace-controller";
import { workspaceMessages } from "./workspace-messages";
import { type WorkspaceTab, webTab, workspaceSelectionHref, workspaceTabId } from "./workspace-state";

function ChatFile(props: { tab: Extract<WorkspaceTab, { kind: "file" }>; refreshKey: string; dirty: (value: boolean) => void }) {
  const source = conversationFileSource("/api/ai", props.tab.conversationId);
  // A view file (chart, table, key figures …) is drawn as in the chat, never shown as its JSON.
  const viewHref =
    isAiViewPath(props.tab.path) && props.tab.path.endsWith(CLOUD_AI_VIEW_SUFFIX) ? source.downloadHref?.(props.tab.path) : undefined;
  if (viewHref) return <CloudViewFile path={props.tab.path} url={viewHref} />;
  const [dirty, setDirty] = createSignal(false);
  const [revision, setRevision] = createSignal(props.refreshKey);
  createEffect(() => {
    if (!dirty()) setRevision(props.refreshKey);
  });
  return (
    <FileView
      variant="plain"
      file={{ path: props.tab.path }}
      load={() => source.read(props.tab.path)}
      revision={revision()}
      save={source.write ? (content) => source.write!(props.tab.path, content, "utf8") : undefined}
      onDirtyChange={(value) => {
        setDirty(value);
        props.dirty(value);
      }}
      downloadHref={source.downloadHref?.(props.tab.path)}
    />
  );
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const extensionOf = (path: string) => {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
};

const tabIcon = (tab: WorkspaceTab) =>
  tab.kind === "context"
    ? tab.category === "files"
      ? "ti ti-layout-list"
      : tab.category === "sources"
        ? "ti ti-world"
        : tab.category === "context"
          ? "ti ti-adjustments"
          : "ti ti-stack-2"
    : tab.kind === "file"
      ? "ti ti-file"
      : tab.kind === "web"
        ? "ti ti-world"
        : "ti ti-file-code";

/** The head of every pane: title, one meta line, at most two actions, and "…" with what Cloud can do with the thing. */
function PaneHead(props: { title: string; meta?: string | null; actions?: JSX.Element; menu: DropdownItem[]; menuLabel: string }) {
  return (
    <header class="artifact-pane__head">
      <div class="artifact-pane__heading">
        <h2 class="artifact-pane__title k2b-truncate-fade" title={props.title}>
          {props.title}
        </h2>
        <p class="artifact-pane__meta k2b-truncate-fade">{props.meta ?? ""}</p>
      </div>
      <div class="artifact-pane__actions">
        {props.actions}
        <Dropdown.Root items={props.menu} align="end" label={props.menuLabel}>
          <Dropdown.Trigger iconOnly size="sm" variant="ghost" label={props.menuLabel} class="artifact-pane__more">
            <i class="ti ti-dots" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </div>
    </header>
  );
}

export function ChatWorkspace(props: {
  controller: ChatWorkspaceController;
  userId: string;
  refreshKey: string;
  project?: AiProject | null;
  conversationId?: string | null;
  onOpenView?: (view: ContextView) => void;
  /** Jumps to a message of the current chat, for results listed in its tabs. */
  onJump?: (target: ChatSidebarJump) => void;
  onOpenSecrets?: () => void;
  /** What the chat holds, for the meta line and the menu of its files and results. */
  snapshot?: Accessor<AssistantChatContextSnapshot | null>;
  /** "Ask Gustav about it": hands the thing to the next message. */
  onAsk?: (title: string) => void;
  /** "Add pane": the chat's whole list. */
  onAdd?: () => void;
  /** The one-time hint that tabs can be arranged was dismissed on this browser, as the server read it. */
  arrangeHintSeen?: boolean;
  /** The operator set up reading web pages: web links of the chat open as reading-view tabs. */
  webReader?: boolean;
}) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t,
    w = () => workspaceMessages.resolve([locale()]).t;
  const state = props.controller.state;
  const [arrangeHintOpen, setArrangeHintOpen] = createSignal(props.arrangeHintSeen !== true);
  // The chat's whole list carries the name of the box it opens from.
  const title = (tab: WorkspaceTab) =>
    tab.kind === "context" ? (tab.category === "files" ? chatSidebarMessages.resolve([locale()]).t.title : t()[tab.category]) : tab.title;
  async function close(key = state().active) {
    if (!key) return;
    if (props.controller.isDirty(key) && !(await prompts.confirm(t().unsavedMessage, { title: t().unsavedTitle, variant: "danger" })))
      return;
    props.controller.close(key);
  }
  const closeOthers = async (key: string) => {
    for (const tab of state().tabs) if (tab.key !== key && !props.controller.isPinned(tab.key)) await close(tab.key);
  };
  const copyLink = async (tab: WorkspaceTab) => {
    try {
      await navigator.clipboard.writeText(new URL(workspaceSelectionHref(window.location.href, tab), window.location.href).href);
      toast.success(w().linkCopied);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };
  const resultOf = (path: string) => props.snapshot?.()?.results.find((result) => result.file?.path === path) ?? null;
  const jumpOf = (result: AssistantChatResult | null): ChatSidebarJump | null =>
    result && result.messageSeq !== null
      ? { messageSeq: result.messageSeq, callId: result.callId, presentationId: result.presentationId ?? null }
      : null;
  /** "heute, 13:40" for today, otherwise the date. */
  const when = (iso: string) => {
    const date = new Date(iso);
    const time = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(date);
    return date.toDateString() === new Date().toDateString()
      ? w().todayAt({ time })
      : new Intl.DateTimeFormat(locale(), { day: "numeric", month: "numeric" }).format(date);
  };
  /** A view's tab carries the sign of what it shows, as its row in the box does. */
  const viewIcon = (tab: WorkspaceTab) => {
    const result = tab.kind === "file" ? resultOf(tab.path) : null;
    return result?.view ? (result.view === "view" ? GENERIC_VIEW_ICON : result.icon) : undefined;
  };
  const meta = (tab: WorkspaceTab): string | null => {
    if (tab.kind === "file") {
      const result = resultOf(tab.path);
      const upload = props.snapshot?.()?.files.find((entry) => entry.path === tab.path) ?? null;
      // A view says what it shows ("Diagramm"), not its JSON's extension and size.
      if (result?.view)
        return [
          viewKindMessages.resolve([locale()]).t[result.view],
          w().madeByGustav({ when: when(result.deliveredAt) }),
          result.description,
        ]
          .filter(Boolean)
          .join(" · ");
      const size = result?.file?.size ?? upload?.size;
      // Kind and size, then who made it and when: "CSV · 605 KB · von Gustav erstellt · heute, 13:40".
      const origin = result
        ? w().madeByGustav({ when: when(result.deliveredAt) })
        : upload?.origin === "user"
          ? w().attachedByYou({ when: when(upload.updatedAt) })
          : null;
      return [extensionOf(tab.path), size === undefined ? null : formatFileViewSize(size, locale()), origin, result?.description]
        .filter(Boolean)
        .join(" · ");
    }
    if (tab.kind === "context") return w().metaContext({ category: tab.category });
    return null;
  };
  const menu = (tab: WorkspaceTab): DropdownItem[] => {
    const copy = w();
    const items: DropdownAction[] = [];
    const result = tab.kind === "file" ? resultOf(tab.path) : null;
    const jump = jumpOf(result);
    if (jump && props.onJump) items.push({ label: copy.showInChat, icon: "ti ti-corner-left-up", action: () => props.onJump!(jump) });
    if (props.onAsk && tab.kind !== "context")
      items.push({ label: copy.ask, icon: "ti ti-sparkles", action: () => props.onAsk!(title(tab)) });
    if (tab.kind !== "view") items.push({ label: copy.copyLink, icon: "ti ti-link", action: () => void copyLink(tab) });
    if (tab.kind === "file") {
      const source = conversationFileSource("/api/ai", tab.conversationId);
      const href = source.downloadHref?.(tab.path) ?? null;
      if (href) {
        items.push({
          label: copy.download,
          icon: "ti ti-download",
          action: () => {
            const link = document.createElement("a");
            link.href = href;
            link.download = fileName(tab.path);
            link.click();
          },
        });
        const file = result?.file ?? props.snapshot?.()?.files.find((entry) => entry.path === tab.path);
        if (file)
          items.push({
            label: saveFilesLabel(locale()),
            icon: SAVE_FILES_ICON,
            action: () => void saveFiles([{ name: fileName(tab.path), content: href, mediaType: file.mediaType, size: file.size }]),
          });
      }
      if (source.remove)
        items.push({
          label: copy.deleteFromChat,
          icon: "ti ti-trash",
          variant: "danger",
          action: async () => {
            const confirmed = await prompts.confirm(copy.deleteConfirm({ name: fileName(tab.path) }), {
              title: copy.deleteFromChat,
              confirmText: copy.delete,
              variant: "danger",
            });
            if (!confirmed) return;
            try {
              await source.remove!(tab.path);
              props.controller.close(tab.key);
            } catch (error) {
              toast.error(error instanceof Error ? error.message : String(error));
            }
          },
        });
    }
    if (tab.kind === "web")
      items.push({ label: copy.openOwn, icon: "ti ti-external-link", action: () => window.open(tab.url, "_blank", "noopener,noreferrer") });
    const pinned = props.controller.isPinned(tab.key);
    // What Cloud can do with the thing, then what the tab itself does; arranging stays with Panes.
    return [
      { items },
      {
        items: [
          {
            label: pinned ? copy.unpin : copy.pin,
            icon: pinned ? "ti ti-pinned-off" : "ti ti-pin",
            trailing: <span class="artifact-pane__hint">{copy.pinHint}</span>,
            action: () => props.controller.togglePin(tab.key),
          },
          { label: copy.close, icon: "ti ti-x", action: () => void close(tab.key) },
          {
            label: copy.closeOthers,
            icon: "ti ti-square-x",
            disabled: state().tabs.length < 2,
            action: () => void closeOthers(tab.key),
          },
        ],
      },
    ];
  };
  /** "…" of a web page: ask about it, copy its address, open it outside, pin, close. */
  const webMenu = (tab: WorkspaceTab, url: string): DropdownItem[] =>
    menu(tab).map((section) =>
      "items" in section
        ? {
            ...section,
            items: section.items.map((item) =>
              item.label === w().copyLink
                ? {
                    ...item,
                    action: async () => {
                      await navigator.clipboard.writeText(url).catch(() => undefined);
                      toast.success(w().linkCopied);
                    },
                  }
                : item,
            ),
          }
        : section,
    );
  const actions = (tab: WorkspaceTab): JSX.Element => {
    if (tab.kind !== "file" || isAiViewPath(tab.path)) return undefined;
    const href = conversationFileSource("/api/ai", tab.conversationId).downloadHref?.(tab.path);
    return href ? (
      <IconButtonLink
        size="sm"
        variant="ghost"
        href={href}
        download={fileName(tab.path)}
        label={w().downloadNamed({ name: fileName(tab.path) })}
        tooltip={w().download}
      >
        <i class="ti ti-download" aria-hidden="true" />
      </IconButtonLink>
    ) : undefined;
  };
  const content = (key: string, tab: WorkspaceTab): JSX.Element =>
    tab.kind === "context" ? (
      <AssistantChatContextContent
        chatId={tab.conversationId}
        project={tab.project !== undefined ? tab.project : tab.conversationId === props.conversationId ? props.project : undefined}
        category={tab.category}
        onOpenView={props.onOpenView}
        onFileDeleted={(file) => props.controller.closeFile(file.conversationId, file.path)}
        onJump={tab.conversationId === props.conversationId ? props.onJump : undefined}
        onOpenSecrets={tab.conversationId === props.conversationId ? props.onOpenSecrets : undefined}
        onOpenWebPage={props.webReader ? (url, title) => props.controller.open(webTab(tab.conversationId, url, title)) : undefined}
      />
    ) : tab.kind === "view" ? (
      tab.render()
    ) : tab.kind === "web" ? (
      <WebReaderTab
        conversationId={tab.conversationId}
        url={tab.url}
        onTitle={(title) => props.controller.rename(key, title)}
        onDismiss={() => props.controller.close(key)}
        menu={(url) => webMenu(tab, url)}
        menuLabel={w().moreNamed({ title: title(tab) })}
      />
    ) : (
      <ChatFile tab={tab} refreshKey={props.refreshKey} dirty={(value) => props.controller.setDirty(key, value)} />
    );
  // Each tab's content is made once and moves between panes, so switching or arranging tabs keeps a run or an editor.
  const owner = getOwner();
  const panes = new Map<string, { element: JSX.Element; dispose: () => void }>();
  const paneOf = (key: string): JSX.Element => {
    let pane = panes.get(key);
    if (!pane) {
      pane = createRoot((dispose) => {
        const tab = () => state().tabs.find((candidate) => candidate.key === key);
        const initial = tab()!;
        const element = (
          <div class="artifact-pane" data-kind={initial.kind}>
            {/* A web page brings its own head: the address bar with its mark and "…". */}
            <Show when={initial.kind !== "web" && tab()}>
              {(current) => (
                <PaneHead
                  title={title(current())}
                  meta={meta(current())}
                  actions={actions(current())}
                  menu={menu(current())}
                  menuLabel={w().moreNamed({ title: title(current()) })}
                />
              )}
            </Show>
            <div class="artifact-pane__body">
              <ErrorBoundary
                fallback={(_error, reset) => (
                  <Placeholder
                    state="error"
                    variant="panel"
                    title={t().loadFailed}
                    description={t().loadFailedDescription}
                    action={
                      <Button variant="secondary" onClick={reset}>
                        <i class="ti ti-refresh" aria-hidden="true" />
                        {t().retry}
                      </Button>
                    }
                  />
                )}
              >
                {content(key, initial)}
              </ErrorBoundary>
            </div>
          </div>
        );
        return { element, dispose };
      }, owner ?? undefined);
      panes.set(key, pane);
    }
    return pane.element;
  };
  createEffect(
    on(
      () => state().tabs.map((tab) => tab.key),
      (keys) => {
        for (const [key, pane] of panes)
          if (!keys.includes(key)) {
            pane.dispose();
            panes.delete(key);
            props.controller.setDirty(key, false);
          }
      },
    ),
  );
  onCleanup(() => {
    for (const pane of panes.values()) pane.dispose();
    panes.clear();
  });
  const items = createMemo<PanesItem[]>(() =>
    state().tabs.map((tab) => ({
      id: workspaceTabId(tab.key),
      title: title(tab),
      icon: viewIcon(tab) ?? tabIcon(tab),
      render: () => paneOf(tab.key),
      onClose: () => void close(tab.key),
    })),
  );
  const layout = createMemo(() => state().layout ?? { version: 2 as const, root: null });
  return (
    <div class="artifact-workspace">
      <Button class="artifact-mobile-toggle" size="sm" variant="ghost" onClick={() => props.controller.setMobile("chat")}>
        <i class="ti ti-chevron-left" aria-hidden="true" />
        {w().backToChat}
      </Button>
      <Panes
        class="artifact-workspace__panes"
        ariaLabel={t().workspace}
        layout={layout()}
        items={items()}
        onLayoutChange={props.controller.setLayout}
        onActivate={props.controller.activateItem}
        onAddItem={props.onAdd ? () => props.onAdd!() : undefined}
        arrangeHint={{
          open: arrangeHintOpen(),
          onDismiss: () => {
            setArrangeHintOpen(false);
            dismissAssistantPanesHint();
          },
        }}
      />
    </div>
  );
}

export { type ChatTabsStore, type ChatWorkspaceController, createChatWorkspace } from "./workspace-controller";
