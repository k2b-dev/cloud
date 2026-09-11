import { render } from "solid-js/web";
import { AppWorkspace, Dropdown } from "@k2b/ui";
render(() => <div class="k2b-ui k2b-app-workspace" data-sidebar-collapsed="true">
  <aside class="k2b-app-workspace__sidebar" data-workspace-collapsible="true" style={{ width: "64px" }}>
    <AppWorkspace.SidebarIconGrid><AppWorkspace.SidebarIconAction icon="ti ti-plus" label="New" /></AppWorkspace.SidebarIconGrid>
    <AppWorkspace.SidebarIconGrid><Dropdown.Root items={[{ label: "All chats", action: () => {} }]}>
      <Dropdown.Trigger appearance="plain" iconOnly label="Chats" class="k2b-app-workspace__sidebar-icon-action"><i class="ti ti-messages" /></Dropdown.Trigger>
    </Dropdown.Root></AppWorkspace.SidebarIconGrid>
  </aside>
  <Dropdown.Root items={[{ label: "Normal item", action: () => {} }]}><Dropdown.Trigger label="Normal">Normal</Dropdown.Trigger></Dropdown.Root>
</div>, document.getElementById("root")!);
