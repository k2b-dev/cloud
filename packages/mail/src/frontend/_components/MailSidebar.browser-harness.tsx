import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import MailSidebar from "./MailSidebar";
import { mailTestFolder } from "./mail-list-test-fixtures";
import { createMailboxPreferences } from "./mail-mailbox-preferences";
import { mailSidebarFixture, openMailboxFixture } from "./mail-sidebar.fixture";

export type MailSidebarHarnessOptions = {
  locale: "en" | "de";
  /** Invented mailbox names; the first one is open. */
  mailboxes: string[];
  /** Positions in `mailboxes` that are hidden. */
  hidden: number[];
  canCreate: boolean;
};

declare global {
  interface Window {
    mountMailSidebar: (options: MailSidebarHarnessOptions) => void;
  }
}

const id = (index: number) => `Box${String(index + 1).padStart(3, "0")}`;

window.mountMailSidebar = (options) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = options.locale;
  const mailboxes = options.mailboxes.map((name, index) => ({
    id: id(index),
    name,
    health: "active" as const,
    healthReason: null,
    receivingAddress: `${id(index).toLowerCase()}@example.test`,
  }));
  // Preferences read the locale, so they are made once inside the provider.
  const Sidebar = () => {
    const preferences = createMailboxPreferences({ pinnedMailboxIds: [], hiddenMailboxIds: options.hidden.map(id) });
    const open = openMailboxFixture({
      mailboxId: id(0),
      mailboxName: options.mailboxes[0]!,
      folders: ["inbox", "drafts", "sent", "archive", "trash"].map((role) => mailTestFolder(role, { unread: role === "inbox" ? 4 : 0 })),
      activeFolderId: "inbox",
    });
    return (
      <MailSidebar
        {...mailSidebarFixture()}
        mailboxes={mailboxes}
        canCreate={options.canCreate}
        counts={[{ mailboxId: id(1), unread: 3, needsAction: 11 }]}
        preferences={preferences}
        open={open}
      />
    );
  };
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <AppWorkspace mobileSurface="flush" class="mail-workspace">
          <Sidebar />
          <AppWorkspace.Content>
            <AppWorkspace.Main>
              <div />
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </LocaleProvider>
    ),
    host,
  );
};
