import { AppWorkspace, LocaleProvider, Navigation } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { apiClient } from "../../api/client";
import type { SenderIdentity } from "../../contracts";
import { openMailboxDetailsDialog } from "./MailboxDetailsDialog";
import MailSidebar from "./MailSidebar";

export type MailboxDetailsHarnessOptions = {
  locale: "en" | "de";
  permission: "read" | "write" | "admin";
  identities: SenderIdentity[];
  /** Also renders the phone app menu from the sidebar's navigation, as Cloud's mobile menu does. */
  phoneMenu?: boolean;
};

declare global {
  interface Window {
    mountMailboxDetails: (options: MailboxDetailsHarnessOptions) => void;
    /** Each result of the details dialog, in order. */
    detailsResults: Array<string | null>;
  }
}

window.detailsResults = [];

const mailbox = { id: "Box001", name: "Support", description: null, health: "active" as const, healthReason: null };
const viewCounts = { needs_action: 0, mine: 0, unassigned: 0, waiting: 0, done: 0, snoozed: 0, send_problems: 0, recently_active: 0 };
const noop = () => {};

window.mountMailboxDetails = (options) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  // Dialogs render outside the island and take the document's language, as in Cloud's pages.
  document.documentElement.lang = options.locale;
  const [detailsOpening, setDetailsOpening] = createSignal(false);
  const [menuReady, setMenuReady] = createSignal(false);
  // Like the mailbox workspace: load the details, then open the dialog complete.
  const openDetails = async () => {
    if (detailsOpening()) return;
    setDetailsOpening(true);
    const response = await apiClient.mailboxes[":mailboxId"].details.$get({ param: { mailboxId: mailbox.id } });
    setDetailsOpening(false);
    if (!response.ok) throw new Error(`Details failed with ${response.status}`);
    const result = await openMailboxDetailsDialog({
      mailbox,
      permission: options.permission,
      identities: options.identities,
      folderCount: 12,
      details: await response.json(),
      dateConfig: { locale: options.locale, timeZone: "UTC" },
    });
    window.detailsResults.push(result ?? null);
  };
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <AppWorkspace mobileSurface="flush" class="mail-workspace">
          <MailSidebar
            mailboxId={mailbox.id}
            mailboxName={mailbox.name}
            syncEnabled
            needsConnection={false}
            folders={[]}
            localTags={[]}
            savedViews={[]}
            scheduledMode={false}
            scheduledCount={0}
            activeFolderId={null}
            activeView={null}
            activeSavedViewId={null}
            activeTagId={null}
            searchActive={false}
            viewCounts={viewCounts}
            canWrite={options.permission !== "read"}
            canAdmin={options.permission === "admin"}
            managementOpening={null}
            settingsOpening={false}
            detailsOpening={detailsOpening()}
            onOpenDetails={() => void openDetails()}
            onOpenHealth={noop}
            onOpenSharedLinks={noop}
            onOpenRemoteContent={noop}
            onOpenSubscriptions={noop}
            onOpenSettings={noop}
            onMoveConversation={noop}
            onNavigate={noop}
          />
          <AppWorkspace.Content>
            <AppWorkspace.Main>
              <Show when={options.phoneMenu && menuReady() && window.__cloudWorkspaceNavigation}>
                {(workspace) => (
                  <div class="mail-phone-menu">
                    <Navigation navigation={workspace().navigation} label={workspace().label} />
                  </div>
                )}
              </Show>
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </LocaleProvider>
    ),
    host,
  );
  // The sidebar registers its navigation once it is mounted.
  queueMicrotask(() => setMenuReady(true));
};
