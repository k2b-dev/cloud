import { AppWorkspace } from "@k2b/ui";

import { createBaseSettings } from "./base-settings";

export default function BaseSettingsButton(props: Parameters<typeof createBaseSettings>[0]) {
  const { t } = createBaseSettings(props);
  return (
    // the base's settings are a page of their own
    <AppWorkspace.SidebarItem href={`/app/grids/${props.base.id}/settings`}>
      <AppWorkspace.SidebarItemIcon icon="ti ti-settings" />
      <AppWorkspace.SidebarItemLabel>{t.settings}</AppWorkspace.SidebarItemLabel>
    </AppWorkspace.SidebarItem>
  );
}
