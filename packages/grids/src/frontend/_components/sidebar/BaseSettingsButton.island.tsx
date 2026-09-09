import { AppWorkspace, dialogCore, panelDialogWideOptions, prompts, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicBase as Base } from "../../../api/public-dto";
import BaseSettingsPanel from "../settings/BaseSettingsPanel";
import type { NavigationResource } from "../workspace/navigation-catalog";
import { sidebarMessages } from "./messages";

export default function BaseSettingsButton(props: { base: Base; navigationResources: NavigationResource[] }) {
  const { t } = sidebarMessages.resolve([useLocale()()]);
  const [open, setOpen] = createSignal(false);

  const showSettings = async () => {
    if (open()) return;
    setOpen(true);
    try {
      const accessResponse = await apiClient.access["by-base"][":baseId"].$get({ param: { baseId: props.base.id } });
      if (!accessResponse.ok) throw new Error(t.loadSettingsFailed);
      const accessEntries = await accessResponse.json();
      await dialogCore.open<void>(
        (close, context) => (
          <div class="flex h-[86vh] min-h-0 flex-col overflow-hidden">
            <BaseSettingsPanel
              base={props.base}
              navigationResources={props.navigationResources}
              accessEntries={accessEntries}
              onClose={() => close()}
              setDismissHandler={context.setDismissHandler}
            />
          </div>
        ),
        panelDialogWideOptions,
      );
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : t.openSettingsFailed);
    } finally {
      setOpen(false);
    }
  };

  return (
    <AppWorkspace.SidebarItem onClick={() => void showSettings()} disabled={open()}>
      <AppWorkspace.SidebarItemIcon icon={open() ? "ti ti-loader-2 animate-spin" : "ti ti-settings"} />
      <AppWorkspace.SidebarItemLabel>{t.settings}</AppWorkspace.SidebarItemLabel>
    </AppWorkspace.SidebarItem>
  );
}
