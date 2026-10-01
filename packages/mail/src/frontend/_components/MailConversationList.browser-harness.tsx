import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { Mailbox } from "../../contracts";
import MailConversationList from "./MailConversationList";
import type { MailListItem } from "./mail-navigation";

export type MailListHarnessOptions = {
  locale: "en" | "de";
  items: MailListItem[];
  selectedConversationId: string | null;
};

declare global {
  interface Window {
    mountMailList: (options: MailListHarnessOptions) => void;
    mailNavigations: string[];
  }
}

window.mailNavigations = [];

const mailbox = { id: "Box001", name: "Example Club", health: "healthy" } as unknown as Mailbox;
const noop = () => {};

window.mountMailList = (options) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  const dateConfig = { locale: options.locale, timeZone: "Europe/Berlin" } as DateContext;
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <AppWorkspace mobileSurface="flush" class="mail-workspace">
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
                  items={options.items}
                  error={null}
                  selectedConversationId={options.selectedConversationId}
                  selectedMessageId={null}
                  selectedConversationIds={new Set()}
                  selectionMode={false}
                  nextCursor={null}
                  dateConfig={dateConfig}
                  canWrite
                  canAdmin={false}
                  junkFolderIds={[]}
                  folders={[]}
                  localTags={[]}
                  savedViews={[]}
                  activeSavedViewId={null}
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
