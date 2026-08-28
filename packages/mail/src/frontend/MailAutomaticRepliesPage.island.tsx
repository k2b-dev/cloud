import { useLocale } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import type { MailAutomaticRepliesWorkspaceData } from "../service/automation-workspace";
import MailAutomaticReplySettings, { type AutomaticReplyPresetId } from "./_components/MailAutomaticReplySettings";
import MailAutomationShell from "./_components/MailAutomationShell";
import { openMailboxSettingsDialog } from "./_components/MailboxSettingsDialog";
import { mailAutomationPageMessages } from "./mail-automation-page-messages";

export default function MailAutomaticRepliesPage(props: {
  data: MailAutomaticRepliesWorkspaceData;
  currentUserEmail: string | null;
  initialPreset: AutomaticReplyPresetId | null;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailAutomationPageMessages.resolve([locale()]).t);
  const [automaticReplies, setAutomaticReplies] = createSignal(props.data.automaticReplies);
  const [referenceConfiguration, setReferenceConfiguration] = createSignal(props.data.referenceConfiguration);
  const [presetRequest, setPresetRequest] = createSignal(props.initialPreset ? { id: props.initialPreset, nonce: 1 } : null);
  const base = `/app/mail/${props.data.mailbox.id}/automations/replies`;

  return (
    <MailAutomationShell
      mailbox={props.data.mailbox}
      permission={props.data.permission}
      currentUserEmail={props.currentUserEmail}
      activePage="replies"
    >
      <header>
        <h1 class="text-base font-semibold text-primary">{messages().automaticReplies}</h1>
        <p class="mt-0.5 text-xs text-dimmed">{messages().automaticRepliesDescription}</p>
      </header>
      <MailAutomaticReplySettings
        mailboxId={props.data.mailbox.id}
        identities={props.data.identities}
        initialConfigurations={automaticReplies()}
        canManage={props.data.canManageAutomaticReplies}
        onManageIdentities={
          props.data.permission === "admin"
            ? () =>
                void openMailboxSettingsDialog({
                  mailboxId: props.data.mailbox.id,
                  currentUserEmail: props.currentUserEmail,
                  initialTab: "delivery",
                })
            : undefined
        }
        onConfigurationsChange={setAutomaticReplies}
        referenceConfiguration={referenceConfiguration()}
        canConfigureReference={props.data.permission === "admin"}
        onReferenceConfigurationChange={setReferenceConfiguration}
        presetRequest={presetRequest}
        onPresetRequestHandled={() => {
          setPresetRequest(null);
          window.history.replaceState(window.history.state, "", base);
        }}
        showHeader={false}
      />
    </MailAutomationShell>
  );
}
