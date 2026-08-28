import { AppWorkspace, useLocale } from "@k2b/ui";
import { createMemo, createSignal, type JSX, Show } from "solid-js";
import type { Mailbox } from "../../contracts";
import { openMailboxSettingsDialog } from "./MailboxSettingsDialog";
import { mailRemainingMessages } from "./mail-remaining-messages";

export type MailAutomationPageId = "overview" | "replies" | "incoming" | "activity" | "workflows";

const pageHref = (mailboxId: string, page: MailAutomationPageId): string =>
  page === "overview" ? `/app/mail/${mailboxId}/automations` : `/app/mail/${mailboxId}/automations/${page}`;

function NavigationItems(props: { mailboxId: string; activePage: MailAutomationPageId; admin: boolean; suffix: string }) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const item = (page: MailAutomationPageId, label: string, icon: string) => (
    <AppWorkspace.SidebarItem
      href={pageHref(props.mailboxId, page)}
      active={props.activePage === page}
      icon={icon}
      navigation="document"
      viewTransitionName={`mail-automations-${page}-${props.suffix}`}
    >
      {label}
    </AppWorkspace.SidebarItem>
  );
  return (
    <>
      <AppWorkspace.SidebarSection title={messages().automation}>
        {item("overview", messages().overview, "ti ti-layout-dashboard")}
        {item("replies", messages().automaticReplies, "ti ti-message-cog")}
        <Show when={props.admin}>{item("incoming", messages().incomingMail, "ti ti-mailbox")}</Show>
      </AppWorkspace.SidebarSection>
      <Show when={props.admin}>
        <AppWorkspace.SidebarSection title={messages().advanced}>
          {item("activity", messages().activity, "ti ti-activity")}
          {item("workflows", messages().workflows, "ti ti-route")}
        </AppWorkspace.SidebarSection>
      </Show>
    </>
  );
}

export default function MailAutomationShell(props: {
  mailbox: Mailbox;
  permission: "read" | "write" | "admin";
  currentUserEmail: string | null;
  activePage: MailAutomationPageId;
  children: JSX.Element;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const [settingsOpening, setSettingsOpening] = createSignal(false);
  const mailboxHref = `/app/mail/${props.mailbox.id}`;
  const openSettings = async () => {
    if (settingsOpening()) return;
    setSettingsOpening(true);
    try {
      await openMailboxSettingsDialog({
        mailboxId: props.mailbox.id,
        currentUserEmail: props.currentUserEmail,
        initialTab: "access",
      });
    } finally {
      setSettingsOpening(false);
    }
  };

  return (
    <AppWorkspace>
      <AppWorkspace.Sidebar>
        <AppWorkspace.SidebarMobileTrigger label={messages().automations} />
        <AppWorkspace.SidebarMobile>
          <AppWorkspace.SidebarMobileItems>
            <AppWorkspace.SidebarItem href={mailboxHref} icon="ti ti-inbox" navigation="document">
              {messages().backToMailbox}
            </AppWorkspace.SidebarItem>
            <AppWorkspace.SidebarItem
              icon={settingsOpening() ? "ti ti-loader-2 animate-spin" : "ti ti-settings"}
              disabled={settingsOpening()}
              onClick={() => void openSettings()}
            >
              {messages().mailboxSettings}
            </AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarMobileItems>
          <AppWorkspace.SidebarMobileBody>
            <NavigationItems
              mailboxId={props.mailbox.id}
              activePage={props.activePage}
              admin={props.permission === "admin"}
              suffix="mobile"
            />
          </AppWorkspace.SidebarMobileBody>
        </AppWorkspace.SidebarMobile>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody scrollPreserveKey={`mail-automations-sidebar-${props.mailbox.id}`}>
            <NavigationItems
              mailboxId={props.mailbox.id}
              activePage={props.activePage}
              admin={props.permission === "admin"}
              suffix="desktop"
            />
          </AppWorkspace.SidebarBody>
          <AppWorkspace.SidebarFooter class="flex flex-col gap-1">
            <AppWorkspace.SidebarItem href={mailboxHref} icon="ti ti-inbox" navigation="document">
              {messages().backToMailbox}
            </AppWorkspace.SidebarItem>
            <AppWorkspace.SidebarItem
              icon={settingsOpening() ? "ti ti-loader-2 animate-spin" : "ti ti-settings"}
              disabled={settingsOpening()}
              onClick={() => void openSettings()}
            >
              {messages().mailboxSettings}
            </AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Content>
        <AppWorkspace.Main class="p-[var(--ui-space-shell)]">
          <div class="flex w-full flex-col gap-3">{props.children}</div>
        </AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
