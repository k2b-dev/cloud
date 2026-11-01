import { codePageFixture } from "@k2b/cloud/ssr/code-page/code-page.fixture";
import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../contact-directory-settings";
import type { MailFolderView } from "../service/messages";
import type { MailboxCodePageData } from "../service/workspace";
import MailboxCode from "./MailboxCode.island";

type State = Parameters<typeof codePageFixture>[0];
declare global {
  interface Window {
    mountMailboxCode: (options: { state: State; locale: "de" | "en"; phone?: boolean }) => void;
  }
}

const folder = (id: string, name: string, role: string, total: number, unread: number): MailFolderView => ({
  id,
  parentId: null,
  name,
  role,
  providerRole: role,
  configuredRole: null,
  selectable: true,
  display: "everywhere",
  effectiveDisplay: "everywhere",
  displayInheritedFromFolderId: null,
  displayNeutral: false,
  namespaceKinds: ["personal"],
  discoveryState: "active",
  missingSince: null,
  syncStatus: "current",
  total,
  unread,
});

/** Fictional mailboxes: a furniture shop. */
const mailbox = (locale: "de" | "en"): MailboxCodePageData => ({
  mailbox: {
    id: "Mb4kd2",
    name: "info@moebel-beispiel.de",
    health: "active",
    healthReason: null,
  } as MailboxCodePageData["mailbox"],
  access: { scope: "mailbox", permission: "admin" },
  folders: [
    folder("Fold01", locale === "de" ? "Posteingang" : "Inbox", "inbox", 120, 12),
    folder("Fold02", locale === "de" ? "Entwürfe" : "Drafts", "drafts", 3, 0),
    folder("Fold03", locale === "de" ? "Gesendet" : "Sent", "sent", 410, 0),
    folder("Fold04", locale === "de" ? "Archiv" : "Archive", "archive", 2200, 0),
  ],
  viewCounts: { needs_action: 4, mine: 2, unassigned: 3, waiting: 1, done: 9, snoozed: 0, send_problems: 0, recently_active: 7, kept: 0 },
  scheduledCount: 0,
  receivingAddress: "info@moebel-beispiel.de",
});

window.mountMailboxCode = ({ state, locale, phone }) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = locale;
  const code = codePageFixture(state, locale);
  render(
    () => (
      <LocaleProvider locale={locale}>
        <MailboxCode
          mailbox={mailbox(locale)}
          sidebar={{
            mailboxes: [
              {
                id: "Mb4kd2",
                name: "info@moebel-beispiel.de",
                health: "active",
                healthReason: null,
                receivingAddress: "info@moebel-beispiel.de",
              },
              { id: "Mb7rch", name: "rechnung@moebel-beispiel.de", health: "active", healthReason: null, receivingAddress: null },
            ],
            pinnedMailboxIds: [],
            hiddenMailboxIds: [],
          }}
          code={phone ? { ...code, activation: { allowed: false, reason: "phone" } } : code}
          currentUserEmail="ben.schulz@moebel-beispiel.de"
          contactDirectory={DEFAULT_MAIL_CONTACT_DIRECTORY}
        />
      </LocaleProvider>
    ),
    host,
  );
};
