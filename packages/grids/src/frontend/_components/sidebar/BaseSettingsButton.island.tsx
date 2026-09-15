import { AppWorkspace } from "@k2b/ui";

import { createBaseSettings } from "./base-settings";

export default function BaseSettingsButton(props: Parameters<typeof createBaseSettings>[0]) {
  const { showSettings, open, t } = createBaseSettings(props);
  return (
    <AppWorkspace.SidebarItem onClick={() => void showSettings()} disabled={open()}>
      <AppWorkspace.SidebarItemIcon icon={open() ? "ti ti-loader-2 animate-spin" : "ti ti-settings"} />
      <AppWorkspace.SidebarItemLabel>{t.settings}</AppWorkspace.SidebarItemLabel>
    </AppWorkspace.SidebarItem>
  );
}
