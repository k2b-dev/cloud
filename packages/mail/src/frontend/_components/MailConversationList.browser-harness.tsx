import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { batch, createSignal, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import type { Mailbox } from "../../contracts";
import type { MailFolderView, MessageDetail } from "../../service/messages";
import MailConversationList from "./MailConversationList";
import MailConversationReader from "./MailConversationReader";
import type { MailConversationToolbarActionId } from "./mail-conversation-toolbar";
import type { MailListItem } from "./mail-navigation";

export type MailListHarnessOptions = {
  locale: "en" | "de";
  items: MailListItem[];
  selectedConversationId: string | null;
  selectionMode?: boolean;
  sidebarCollapsed?: boolean;
  /** Folders whose mail stays inside them, which All mail and the work views name one after another. */
  folderOnlyHints?: MailFolderView[];
  /**
   * Opens a clicked conversation in the real reader, as the workspace does: the URL follows through the
   * history, the detail arrives as one reconciled snapshot, and back and forward restore it.
   */
  reader?: boolean;
  /** Starts the list at this route and lets it navigate through the history, as the workspace does. */
  requestUrl?: string;
  /** The reader's toolbar; Reply by default. */
  toolbarActions?: MailConversationToolbarActionId[];
  /** The mail server deleted the messages of kept conversations, so the reader shows Cloud's copies. */
  deletedOnServer?: boolean;
  /** Replaces the body of plain text messages, for example with quoted text. */
  plainText?: string;
};

declare global {
  interface Window {
    mountMailList: (options: MailListHarnessOptions) => void;
    /** Replaces the list items like a live list update: rows keep their identity by id. */
    setMailItems: (items: MailListItem[]) => void;
    /** Marks rows as leaving, as the workspace does while an action takes them out of the list. */
    setMailLeaving: (keys: string[]) => void;
    mailItems: () => MailListItem[];
    mailNavigations: string[];
    folderHintDismissed: boolean;
  }
}

window.mailNavigations = [];
window.folderHintDismissed = false;

const mailbox = { id: "Box001", name: "Example Club", health: "healthy" } as unknown as Mailbox;
const noop = () => {};

/** One message per conversation; even rows have an HTML body in its frame, odd rows a plain text body. */
const detailFor = (item: MailListItem | undefined, deletedOnServer = false, plainText?: string) => {
  if (!item?.conversationId) return { selectedConversationId: null, subject: "", messages: [] as MessageDetail[] };
  const html = Number(item.conversationId.slice(2)) % 2 === 0;
  const message: MessageDetail = {
    id: `Msg${item.conversationId.slice(2)}`,
    subject: item.subject,
    messageId: `<${item.conversationId}@example.test>`,
    internalDate: item.latestMessageAt,
    sentAt: item.latestMessageAt,
    from: [{ name: item.participantLabels[0] ?? "", address: "person@example.test" }],
    to: [],
    preview: item.preview,
    hasAttachments: false,
    replyTo: [],
    cc: [],
    flags: [],
    keywords: [],
    hydrationStatus: "complete",
    remoteAvailable: true,
    folderId: "Fold01",
    deletedOnServer: deletedOnServer && item.kept,
    contentType: html ? "text/html" : "text/plain",
    sizeBytes: 64,
    plainText: (!html && plainText) || `Body of ${item.subject}`,
    sanitizedHtml: html ? `<p>Body of ${item.subject}</p>` : null,
    forwardText: "",
    selectedHeaders: {},
    sourceAvailable: true,
    mailingList: null,
    remoteContent: { imageIds: [], allowedByRule: false, sender: "person@example.test", domain: "example.test" },
    delivery: null,
    attachments: [],
  };
  return { selectedConversationId: item.conversationId, subject: item.subject, messages: [message] };
};

window.mountMailList = (options) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  const dateConfig = { locale: options.locale, timeZone: "Europe/Berlin" } as DateContext;
  const [list, setList] = createStore({ items: options.items });
  const [hintFolders, setHintFolders] = createSignal(options.folderOnlyHints ?? []);
  window.setMailItems = (items) => setList("items", reconcile(items));
  const [leaving, setLeaving] = createSignal<ReadonlySet<string>>(new Set());
  window.setMailLeaving = (keys) => setLeaving(new Set(keys));
  window.mailItems = () => [...list.items];
  const [selected, setSelected] = createSignal(options.selectedConversationId);
  const [detail, setDetail] = createStore(
    detailFor(
      options.items.find((item) => item.conversationId === selected()),
      options.deletedOnServer,
      options.plainText,
    ),
  );
  // Keeping arrives with the next snapshot, like the workspace's: the open row's state decides the reader's.
  const keep = () => {
    const item = list.items.find((candidate) => candidate.conversationId === selected());
    return item?.kept && item.conversationId
      ? {
          conversationId: item.conversationId,
          keptAt: "2026-09-30T08:00:00.000Z",
          keptBy: { kind: "user" as const, id: "user-grace", displayName: "Grace Hopper", avatarHash: null },
        }
      : null;
  };
  const open = (conversationId: string | null) =>
    batch(() => {
      setSelected(conversationId);
      setDetail(
        reconcile(
          detailFor(
            list.items.find((item) => item.conversationId === conversationId),
            options.deletedOnServer,
            options.plainText,
          ),
        ),
      );
    });
  const [route, setRoute] = createSignal(options.requestUrl);
  const updateRoute = () => setRoute(location.pathname + location.search);
  const openHref = (href: string, replace = false) => {
    if (!options.requestUrl) return;
    window.mailNavigations.push(href);
    if (replace) history.replaceState(null, "", href);
    else history.pushState(null, "", href);
    updateRoute();
  };
  if (options.requestUrl) {
    history.replaceState(null, "", options.requestUrl);
    window.addEventListener("popstate", updateRoute);
  }
  const requestUrl = () => route() ?? `/app/mail/Box001${selected() ? `?conversation=${selected()}` : ""}`;
  if (options.reader) {
    history.replaceState(null, "", requestUrl());
    window.addEventListener("popstate", () => open(new URL(location.href).searchParams.get("conversation")));
  }
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <AppWorkspace
          mobileSurface="flush"
          class="mail-workspace"
          layoutState={() => (options.sidebarCollapsed ? { version: 2, sidebarCollapsed: true } : null)}
        >
          <AppWorkspace.Sidebar class="mail-workspace-navigation">
            <AppWorkspace.SidebarDesktop>
              <AppWorkspace.SidebarBody>
                <AppWorkspace.SidebarSection title="Mail">
                  <AppWorkspace.SidebarItem href="#inbox" icon="ti ti-inbox" active>
                    Inbox
                  </AppWorkspace.SidebarItem>
                  <AppWorkspace.SidebarItem href="#sent" icon="ti ti-send">
                    Sent
                  </AppWorkspace.SidebarItem>
                </AppWorkspace.SidebarSection>
              </AppWorkspace.SidebarBody>
            </AppWorkspace.SidebarDesktop>
          </AppWorkspace.Sidebar>
          <AppWorkspace.Content>
            <AppWorkspace.Main class="p-0" mobilePane={options.selectedConversationId ? "main" : "conversations"} scroll={false}>
              <AppWorkspace.MainPane
                id="conversations"
                label="Conversations"
                scroll={false}
                open
                defaultSize={430}
                minSize={300}
                maxSize={620}
              >
                <MailConversationList
                  mailbox={mailbox}
                  mailboxId="Box001"
                  requestUrl={requestUrl()}
                  query={options.requestUrl ? (new URL(requestUrl(), location.origin).searchParams.get("q") ?? "") : ""}
                  search={{ query: "", expression: null, sort: "relevance", error: null }}
                  title="Inbox"
                  items={list.items}
                  leavingKeys={leaving()}
                  error={null}
                  selectedConversationId={selected()}
                  selectedMessageId={null}
                  selectedConversationIds={new Set()}
                  selectionMode={options.selectionMode ?? false}
                  nextCursor={null}
                  dateConfig={dateConfig}
                  canWrite
                  canAdmin={false}
                  viewFolderId={null}
                  folders={[]}
                  localTags={[]}
                  savedViews={[]}
                  activeSavedViewId={null}
                  folderOnlyHint={(() => {
                    const folder = hintFolders()[0];
                    return folder
                      ? {
                          folder,
                          dismiss: () => {
                            window.folderHintDismissed = true;
                            setHintFolders((folders) => folders.slice(1));
                          },
                        }
                      : null;
                  })()}
                  listMode="conversations"
                  loading={false}
                  liveDegraded={false}
                  onCollapse={noop}
                  onOpenHealth={noop}
                  onOpenDeliverySettings={noop}
                  onNavigate={(nav) => {
                    if (!options.requestUrl) return;
                    window.mailNavigations.push(nav.href);
                    nav.push();
                    updateRoute();
                  }}
                  onNavigateItem={(href) => {
                    window.mailNavigations.push(href);
                    if (!options.reader) return;
                    history.pushState(null, "", href);
                    open(new URL(href, location.href).searchParams.get("conversation"));
                  }}
                  onToggleSelectionMode={noop}
                  onListModeChange={noop}
                  onToggleSelection={noop}
                  onClearSelection={noop}
                  onAddTags={noop}
                  onAssign={noop}
                  onBulkAction={noop}
                  onItemAction={noop}
                  onManageTags={noop}
                  onMergeItem={noop}
                  onOpenHref={openHref}
                  onLoadMore={() => false}
                  onRefresh={async () => {}}
                />
              </AppWorkspace.MainPane>
              <div id="reader" class="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--ui-surface-raised)]">
                <Show when={options.reader} fallback="Reader">
                  <MailConversationReader
                    mailboxId="Box001"
                    requestUrl={requestUrl()}
                    canWrite
                    canAdmin={false}
                    mailboxWide
                    identities={[]}
                    onOpenDeliverySettings={noop}
                    selectionKey={detail.selectedConversationId}
                    selectedConversationId={detail.selectedConversationId}
                    selectedMessageId={null}
                    unread={false}
                    flagged={false}
                    inJunk={false}
                    keep={keep()}
                    reference={null}
                    subject={detail.subject}
                    messages={detail.messages}
                    activity={[]}
                    conversationSummary={null}
                    conversationDrafts={[]}
                    totalMessageCount={detail.messages.length}
                    error={null}
                    dateConfig={dateConfig}
                    readingFormat="automatic"
                    theme="light"
                    calendarIntegrationAvailable={false}
                    listCollapsed={false}
                    detailsOpen={false}
                    toolbarActions={options.toolbarActions ?? ["reply"]}
                    onRestoreList={noop}
                    onToggleDetails={noop}
                    onToolbarActionsChange={noop}
                    actionPending={false}
                    structurePending={false}
                    onAction={noop}
                    onOpenHref={noop}
                    onManageTags={noop}
                    onMergeConversation={noop}
                    onReassignMessage={noop}
                    onSplitMessage={noop}
                    onKeep={noop}
                    onStopKeeping={noop}
                    onSummarySaved={async () => {}}
                    onReconcile={async () => {}}
                    onReconcileAfterWrite={async () => {}}
                    onClose={noop}
                  />
                </Show>
              </div>
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </LocaleProvider>
    ),
    host,
  );
};
