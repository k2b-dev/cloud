import { NoticeCard, useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";
import type { MailIncomingAutomationsWorkspaceData } from "../service/automation-workspace";
import MailAutomationShell from "./_components/MailAutomationShell";
import MailIncomingAutomationSettings, { type IncomingAutomationPreset } from "./_components/MailIncomingAutomationSettings";
import { mailAutomationPageMessages } from "./mail-automation-page-messages";

export default function MailIncomingAutomationsPage(props: {
  data: MailIncomingAutomationsWorkspaceData;
  currentUserEmail: string | null;
  openPreset: IncomingAutomationPreset | null;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailAutomationPageMessages.resolve([locale()]).t);
  const base = `/app/mail/${props.data.mailbox.id}/automations/incoming`;
  return (
    <MailAutomationShell
      mailbox={props.data.mailbox}
      permission={props.data.permission}
      currentUserEmail={props.currentUserEmail}
      activePage="incoming"
    >
      <header>
        <h1 class="text-base font-semibold text-primary">{messages().incomingMail}</h1>
        <p class="mt-0.5 text-xs text-dimmed">{messages().incomingMailDescription}</p>
      </header>
      <NoticeCard tone="info" icon={false} bodyClass="flex items-start gap-2">
        <i class="ti ti-info-circle mt-0.5 shrink-0" aria-hidden="true" />
        <span>{messages().incomingMailNotice}</span>
      </NoticeCard>
      <MailIncomingAutomationSettings
        mailboxId={props.data.mailbox.id}
        catalog={props.data.catalog}
        initialAutomations={props.data.incomingAutomations}
        openPreset={props.openPreset}
        onOpenPresetHandled={() => window.history.replaceState(window.history.state, "", base)}
      />
    </MailAutomationShell>
  );
}
