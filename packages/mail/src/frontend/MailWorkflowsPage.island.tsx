import { NoticeCard, useLocale } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import type { MailWorkflowsWorkspaceData } from "../service/automation-workspace";
import MailAutomationShell from "./_components/MailAutomationShell";
import { MailReferenceConfigurationCard } from "./_components/MailResponsePolicySettings";
import MailWorkflowSettings from "./_components/MailWorkflowSettings";
import { mailAutomationPageMessages } from "./mail-automation-page-messages";

export default function MailWorkflowsPage(props: { data: MailWorkflowsWorkspaceData; currentUserEmail: string | null; openNew: boolean }) {
  const locale = useLocale();
  const messages = createMemo(() => mailAutomationPageMessages.resolve([locale()]).t);
  const [workflows, setWorkflows] = createSignal(props.data.workflows);
  const [referenceConfiguration, setReferenceConfiguration] = createSignal(props.data.referenceConfiguration);
  const base = `/app/mail/${props.data.mailbox.id}/automations/workflows`;
  return (
    <MailAutomationShell
      mailbox={props.data.mailbox}
      permission={props.data.permission}
      currentUserEmail={props.currentUserEmail}
      activePage="workflows"
    >
      <header>
        <h1 class="text-base font-semibold text-primary">{messages().workflows}</h1>
        <p class="mt-0.5 text-xs text-dimmed">{messages().workflowsDescription}</p>
      </header>
      <NoticeCard tone="info" icon={false} bodyClass="flex items-start gap-2">
        <i class="ti ti-info-circle mt-0.5 shrink-0" aria-hidden="true" />
        <span>{messages().workflowsNotice}</span>
      </NoticeCard>
      <MailReferenceConfigurationCard
        mailboxId={props.data.mailbox.id}
        configuration={referenceConfiguration()}
        onConfigurationChange={setReferenceConfiguration}
      />
      <MailWorkflowSettings
        mailboxId={props.data.mailbox.id}
        initialWorkflows={workflows()}
        referenceConfiguration={referenceConfiguration()}
        onReferenceConfigurationChange={setReferenceConfiguration}
        onWorkflowsChange={setWorkflows}
        openNew={props.openNew}
        onOpenNewHandled={() => window.history.replaceState(window.history.state, "", base)}
      />
    </MailAutomationShell>
  );
}
