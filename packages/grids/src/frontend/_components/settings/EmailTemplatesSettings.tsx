import { Button, dialogCore, panelDialogWorkspaceOptions, SettingsGroup, useLocale } from "@k2b/ui";
import { navigationMessages } from "../../../navigation-messages";
import { sidebarMessages } from "../sidebar/messages";
import { EmailTemplateManager } from "../workflows/WorkflowEmailTemplates";

export default function EmailTemplatesSettings(props: { baseId: string }) {
  const { t } = sidebarMessages.resolve([useLocale()()]);
  const { t: nav } = navigationMessages.resolve([useLocale()()]);
  const openManager = async () => {
    await dialogCore.open<void>(
      (close) => <EmailTemplateManager baseId={props.baseId} onChanged={() => undefined} onClose={close} />,
      panelDialogWorkspaceOptions,
    );
  };

  return (
    <SettingsGroup title={t.emailTemplates} description={nav.emailTemplatesDescription}>
      <SettingsGroup.Action>
        <Button variant="secondary" onClick={() => void openManager()}>
          {nav.manageEmailTemplates}
        </Button>
      </SettingsGroup.Action>
    </SettingsGroup>
  );
}
