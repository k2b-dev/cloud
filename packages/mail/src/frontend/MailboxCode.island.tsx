import { CodePage, type CodePageData } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { AppWorkspace } from "@k2b/ui";
import type { MailContactDirectory } from "../contact-directory-settings";
import type { MailboxCodePageData } from "../service/workspace";
import MailSidebar from "./_components/MailSidebar";
import { MailContactDirectoryProvider } from "./_components/mail-contact-directory-context";
import { createMailboxPreferences } from "./_components/mail-mailbox-preferences";
import type { MailSidebarData } from "./mail-sidebar-data";

/** The mailbox's tools live on its own page; beside its Code the sidebar row offers none. */
const noMailboxMenu = { sections: () => [], busy: () => false, syncing: () => false };

/** Code of one mailbox: Mail's own sidebar with "Code" selected, and the shared Code page beside it. */
export default function MailboxCode(props: {
  mailbox: MailboxCodePageData;
  sidebar: MailSidebarData;
  code: CodePageData;
  currentUserEmail: string | null;
  contactDirectory: MailContactDirectory;
}) {
  const preferences = createMailboxPreferences(props.sidebar);
  const state = () => props.code.state;
  // Paused Code or removed access needs someone who administers it.
  const attention = () => {
    const current = state();
    return current.kind === "ready" && (current.code.state === "paused" || (current.access ?? []).some((row) => row.state === "removed"));
  };
  return (
    <MailContactDirectoryProvider value={props.contactDirectory}>
      <AppWorkspace mobileSurface="flush" class="mail-workspace">
        <MailSidebar
          canCreate
          currentUserEmail={props.currentUserEmail}
          contactDirectory={props.contactDirectory}
          mailboxes={props.sidebar.mailboxes}
          preferences={preferences}
          counts={[]}
          open={{
            mailboxId: props.mailbox.mailbox.id,
            mailboxName: props.mailbox.mailbox.name,
            canWrite: props.mailbox.access.permission !== "read",
            assignedOnly: props.mailbox.access.scope === "assigned",
            mailbox: {
              health: props.mailbox.mailbox.health,
              healthReason: props.mailbox.mailbox.healthReason,
              receivingAddress: props.mailbox.receivingAddress,
            },
            folders: props.mailbox.folders,
            scheduledMode: false,
            scheduledCount: props.mailbox.scheduledCount,
            activeFolderId: null,
            activeView: null,
            viewCounts: props.mailbox.viewCounts,
            menu: noMailboxMenu,
            onCompose: (options) => options.fallback(),
            onMoveConversation: () => undefined,
            onNavigate: (nav) => navigateTo(nav.href),
            code: { active: true, attention: attention() },
          }}
        />
        <AppWorkspace.Content>
          <AppWorkspace.Main class="p-[var(--ui-space-shell)]">
            <CodePage data={props.code} />
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </MailContactDirectoryProvider>
  );
}
