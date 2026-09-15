import { AppWorkspace } from "@k2b/ui";
import { Show } from "solid-js";
import { createNewResource } from "./new-resource";

export default function NewResourceButton(props: Parameters<typeof createNewResource>[0]) {
  const { open, busy, choices, t } = createNewResource(props);
  return (
    <Show when={choices.length > 0}>
      <AppWorkspace.SidebarItem tone="success" disabled={busy()} onClick={() => void open()}>
        <AppWorkspace.SidebarItemIcon icon="ti ti-plus" />
        <AppWorkspace.SidebarItemLabel>{t.newResource}</AppWorkspace.SidebarItemLabel>
      </AppWorkspace.SidebarItem>
    </Show>
  );
}
