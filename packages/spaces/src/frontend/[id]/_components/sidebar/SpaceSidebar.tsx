import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace } from "@k2b/ui";
import SpaceNavigation from "./SpaceNavigation.island";
import type { SpacesSidebarData } from "./SpacesSidebarList";
import SpacesSidebarList from "./SpacesSidebarList.island";
import type { SpaceContext } from "./types";

type Props = {
  ctx: SpaceContext;
  dateConfig?: DateContext;
  sidebar: SpacesSidebarData;
};

export default function SpaceSidebar(props: Props) {
  return (
    <>
      <SpaceNavigation ctx={props.ctx} sidebar={props.sidebar} dateConfig={props.dateConfig} />
      <AppWorkspace.Sidebar label="Spaces" collapsible>
        <AppWorkspace.SidebarDesktop>
          <SpacesSidebarList
            spaces={props.sidebar.spaces}
            pinnedSpaceIds={props.sidebar.pinnedSpaceIds}
            myWorkCount={props.sidebar.myWorkCount}
            current={{ kind: "space", id: props.ctx.space.id }}
            canCreate={Boolean(props.ctx.userId)}
          />
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
    </>
  );
}
