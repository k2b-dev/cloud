import { AppWorkspace } from "@k2b/ui";
import DatabaseTableFixture from "../../../../test/fixtures/database-table.island";

export default function WorkspaceFixture() {
  return (
    <AppWorkspace>
      <AppWorkspace.Sidebar>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarItem href="/app/grids/base" active>
            Projects
          </AppWorkspace.SidebarItem>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Content>
        <AppWorkspace.Main class="p-[var(--ui-space-shell)]" scroll={false}>
          <DatabaseTableFixture />
        </AppWorkspace.Main>
        <AppWorkspace.Detail id="record" width="lg" open>
          Selected record
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
