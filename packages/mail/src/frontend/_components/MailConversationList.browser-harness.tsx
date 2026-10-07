import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { batch, createSignal, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import type { Mailbox } from "../../contracts";
import type { MailFolderView, MessageDetail } from "../../service/messages";
import MailConversationList from "./MailConversationList";
import MailConversationReader from "./MailConversationReader";
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
};

declare global {
  interface Window {
    mountMailList: (options: MailListHarnessOptions) => void;
    /** Replaces the list items like a live list update: rows keep their identity by id. */
    setMailItems: (items: MailListItem[]) => void;
    mailNavigations: string[];
    folderHintDismissed: boolean;
  }
}

window.mailNavigations = [];
window.folderHintDismissed = false;

const mailbox = { id: "Box001", name: "Example Club", health: "healthy" } as unknown as Mailbox;
const noop = () => {};

/** One message per conversation; even rows have an HTML body in its frame, odd rows a plain text body. */
const detailFor = (item: MailListItem | undefined) => {
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
    contentType: html ? "text/html" : "text/plain",
    sizeBytes: 64,
    plainText: `Body of ${item.subject}`,
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
  const [selected, setSelected] = createSignal(options.selectedConversationId);
  const [detail, setDetail] = createStore(detailFor(options.items.find((item) => item.conversationId === selected())));
  const open = (conversationId: string | null) =>
    batch(() => {
      setSelected(conversationId);
      setDetail(reconcile(detailFor(list.items.find((item) => item.conversationId === conversationId))));
    });
  const requestUrl = () => `/app/mail/Box001${selected() ? `?conversation=${selected()}` : ""}`;
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
                  query=""
                  title="Inbox"
                  items={list.items}
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
                  onNavigate={noop}
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
                  onOpenHref={noop}
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
                    identities={[]}
                    selectionKey={detail.selectedConversationId}
                    selectedConversationId={detail.selectedConversationId}
                    selectedMessageId={null}
                    unread={false}
                    flagged={false}
                    inJunk={false}
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
                    toolbarActions={["reply"]}
                    onRestoreList={noop}
                    onToggleDetails={noop}
                    onToolbarActionsChange={noop}
                    actionPending={false}
                    onAction={noop}
                    onOpenHref={noop}
                    onManageTags={noop}
                    onMergeConversation={noop}
                    onReassignMessage={noop}
                    onSplitMessage={noop}
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
