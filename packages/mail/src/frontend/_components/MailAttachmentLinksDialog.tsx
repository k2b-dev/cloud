import type { DateContext } from "@k2b/stdlib";
import { dialogCore, PanelDialog, panelDialogFixedOptions, useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";
import MailAttachmentLinksSettings from "./MailAttachmentLinksSettings";
import { mailSettingsMessages } from "./mail-settings-messages";

function MailAttachmentLinksDialog(props: { mailboxId: string; dateConfig: DateContext; close: () => void }) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  return (
    <PanelDialog>
      <PanelDialog.Header title={messages().sharedLinks} subtitle={messages().sharedLinksSubtitle} icon="ti ti-link" close={props.close} />
      <PanelDialog.Body>
        <MailAttachmentLinksSettings mailboxId={props.mailboxId} dateConfig={props.dateConfig} />
      </PanelDialog.Body>
    </PanelDialog>
  );
}

export const openMailAttachmentLinksDialog = async (params: { mailboxId: string; dateConfig?: DateContext }): Promise<void> => {
  await dialogCore.open<void>(
    (close) => <MailAttachmentLinksDialog mailboxId={params.mailboxId} dateConfig={params.dateConfig ?? {}} close={() => close()} />,
    panelDialogFixedOptions,
  );
};
