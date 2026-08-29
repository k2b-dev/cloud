import { AppWorkspace, dialogCore, panelDialogWorkspaceOptions, useLocale } from "@k2b/ui";
import { EmailTemplateManager } from "../workflows/WorkflowEmailTemplates";
import { sidebarMessages } from "./messages";

export default function EmailTemplatesButton(props: { baseId: string }) {
  const { t } = sidebarMessages.resolve([useLocale()()]);
  const openManager = async () => {
    await dialogCore.open<void>(
      (close) => <EmailTemplateManager baseId={props.baseId} onChanged={() => undefined} onClose={close} />,
      panelDialogWorkspaceOptions,
    );
  };

  return (
    <AppWorkspace.SidebarItem tone="success" onClick={() => void openManager()}>
      <AppWorkspace.SidebarItemIcon icon="ti ti-mail" />
      <AppWorkspace.SidebarItemLabel>{t.emailTemplates}</AppWorkspace.SidebarItemLabel>
    </AppWorkspace.SidebarItem>
  );
}
