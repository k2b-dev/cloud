import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import type { Mailbox } from "../../contracts";
import type { MailFolderView } from "../../service/messages";
import MailConversationList from "./MailConversationList";
import type { MailListItem } from "./mail-navigation";

export type MailListHarnessOptions = {
  locale: "en" | "de";
  items: MailListItem[];
  selectedConversationId: string | null;
  selectionMode?: boolean;
  sidebarCollapsed?: boolean;
  /** Folders whose mail stays inside them, which All mail and the work views name one after another. */
  folderOnlyHints?: MailFolderView[];
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

window.mountMailList = (options) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  const dateConfig = { locale: options.locale, timeZone: "Europe/Berlin" } as DateContext;
  const [list, setList] = createStore({ items: options.items });
  const [hintFolders, setHintFolders] = createSignal(options.folderOnlyHints ?? []);
  window.setMailItems = (items) => setList("items", reconcile(items));
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
                  requestUrl={`/app/mail/Box001${options.selectedConversationId ? `?conversation=${options.selectedConversationId}` : ""}`}
                  query=""
                  title="Inbox"
                  items={list.items}
                  error={null}
                  selectedConversationId={options.selectedConversationId}
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
                Reader
              </div>
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </LocaleProvider>
    ),
    host,
  );
};
