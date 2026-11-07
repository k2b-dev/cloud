import { AppWorkspace } from "@k2b/ui";
import type { JSX } from "solid-js";
import DatabaseTableFixture from "../../../../test/fixtures/database-table.island";
import RecordsFieldsMenuFixture from "../../../../test/fixtures/records-fields-menu.island";

const contents: Record<string, () => JSX.Element> = {
  "/app/grids/base": () => <DatabaseTableFixture />,
  "/app/grids/cards": () => <RecordsFieldsMenuFixture />,
};

export default function WorkspaceFixture(props: { path: string }) {
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
          {contents[props.path]?.()}
        </AppWorkspace.Main>
        <AppWorkspace.Detail id="record" width="lg" open>
          Selected record
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
