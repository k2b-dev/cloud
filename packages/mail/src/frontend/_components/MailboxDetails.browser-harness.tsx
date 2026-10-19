import { AppWorkspace, LocaleProvider, Navigation } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { apiClient } from "../../api/client";
import type { SenderIdentity } from "../../contracts";
import { openMailboxDetailsDialog } from "./MailboxDetailsDialog";
import { createMailboxMenu, MailboxMenuButton } from "./MailboxMenu";
import MailSidebar from "./MailSidebar";
import { mailboxMenuOptions, mailSidebarFixture, openMailboxFixture } from "./mail-sidebar.fixture";
import { mailSidebarMessages } from "./mail-sidebar-messages";

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
    setMailboxComposeStarting: (starting: boolean) => void;
    /** Each result of the details dialog, in order. */
    detailsResults: Array<string | null>;
  }
}

window.detailsResults = [];

const mailbox = { id: "Box001", name: "Support", description: null, health: "active" as const, healthReason: null };

window.mountMailboxDetails = (options) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  // Dialogs render outside the island and take the document's language, as in Cloud's pages.
  document.documentElement.lang = options.locale;
  const [detailsOpening, setDetailsOpening] = createSignal(false);
  const [composeStarting, setComposeStarting] = createSignal(false);
  window.setMailboxComposeStarting = setComposeStarting;
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
            {...mailSidebarFixture()}
            open={openMailboxFixture({
              menu: createMailboxMenu(() =>
                mailboxMenuOptions({
                  canWrite: options.permission !== "read",
                  canAdmin: options.permission === "admin",
                  detailsOpening: detailsOpening(),
                  onOpenDetails: () => void openDetails(),
                }),
              ),
            })}
          />
          <AppWorkspace.Head
            actions={
              <MailboxMenuButton
                menu={createMailboxMenu(() =>
                  mailboxMenuOptions({
                    canWrite: options.permission !== "read",
                    canAdmin: options.permission === "admin",
                    detailsOpening: detailsOpening(),
                    onOpenDetails: () => void openDetails(),
                  }),
                )}
                label={mailSidebarMessages.resolve([options.locale]).t.mailboxMenu({ name: "Support" })}
              />
            }
            primary={
              options.permission !== "read"
                ? {
                    label: options.locale === "de" ? "Verfassen" : "Compose",
                    href: "/app/mail/compose?mailbox=Box001&autostart=1",
                    icon: composeStarting() ? "ti ti-loader-2 animate-spin" : "ti ti-pencil",
                  }
                : undefined
            }
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
