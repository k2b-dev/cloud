import { LocaleProvider, ViewTabs } from "@k2b/ui";
import { render } from "solid-js/web";
import type { KeptConversationExport } from "../../contracts";
import type { KeepHistoryEntry } from "../../service/kept-conversations";
import { mailKeptAdminMessages } from "../kept-admin-messages";
import MailAdminKeptDetail from "./MailAdminKeptDetail";
import MailAdminKeptTable, { type KeptTableRow } from "./MailAdminKeptTable.island";

export type KeptAdminHarnessOptions = {
  locale: "en" | "de";
  rows: KeptTableRow[];
  detail?: { conversation: KeptConversationExport["conversations"][number]; history: KeepHistoryEntry[]; messageCount: number };
};

declare global {
  interface Window {
    mountKeptAdmin: (options: KeptAdminHarnessOptions) => void;
  }
}

// The page's server render, reduced to the tab strip and the two islands it hands its snapshot to.
window.mountKeptAdmin = (options) => {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing harness root");
  const t = mailKeptAdminMessages.resolve([options.locale]).t;
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <main class="flex min-w-0 flex-1 flex-col gap-4 overflow-auto p-4">
          <ViewTabs
            label={t.tabsLabel}
            current="kept"
            items={[
              { id: "mailboxes", label: t.tabMailboxes, href: "/admin/mail" },
              { id: "security", label: t.tabSecurity, href: "/admin/mail/security" },
              { id: "kept", label: t.tabKept, href: "/admin/mail/kept", count: options.rows.length },
            ]}
          />
          {options.detail ? (
            <MailAdminKeptDetail
              conversation={options.detail.conversation}
              history={options.detail.history}
              messageCount={options.detail.messageCount}
              dateConfig={{ locale: options.locale, timeZone: "Europe/Berlin" }}
            />
          ) : (
            <MailAdminKeptTable rows={options.rows} emptyTitle={t.empty} emptyDescription={t.emptyDescription} />
          )}
        </main>
      </LocaleProvider>
    ),
    root,
  );
};
