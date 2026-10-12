import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace } from "@k2b/ui";
import { Show } from "solid-js";
import SearchButton from "../search/SearchButton.island";
import CopyICalButton from "./CopyICalButton.island";
import CreateItemButton from "./CreateItemButton.island";
import SpaceNavigation from "./SpaceNavigation.island";
import SpaceSettingsButton from "./SpaceSettingsButton.island";
import SpaceSwitcher from "./SpaceSwitcher.island";
import type { SpaceContext } from "./types";
import ViewLinks from "./ViewLinks.island";

type Props = {
  ctx: SpaceContext;
  baseUrl: string;
  dateConfig?: DateContext;
};

export default function SpaceSidebar(props: Props) {
  const vt = (key: string) => `space-sidebar-${props.ctx.space.id}-${key}`;

  return (
    <>
      <SpaceNavigation ctx={props.ctx} baseUrl={props.baseUrl} dateConfig={props.dateConfig} />
      <AppWorkspace.Sidebar collapsible>
        <AppWorkspace.SidebarDesktop>
          <SpaceSwitcher space={{ id: props.ctx.space.id, name: props.ctx.space.name, color: props.ctx.space.color }} />
          <div class="flex flex-col gap-3">
            <Show
              when={props.ctx.canWrite}
              fallback={
                <div data-sidebar-mode="expanded">
                  <SearchButton spaceId={props.ctx.space.id} spaceName={props.ctx.space.name} variant="sidebar" registerCommand />
                </div>
              }
            >
              <AppWorkspace.SidebarIconGrid columns={2} sidebarMode="expanded">
                <div style={`view-transition-name:${vt("create-desktop")}`}>
                  <CreateItemButton
                    spaceId={props.ctx.space.id}
                    columns={props.ctx.columns}
                    tags={props.ctx.tags}
                    templates={props.ctx.space.templates}
                    dateConfig={props.dateConfig}
                    variant="icon"
                    defaultType={props.ctx.currentView === "calendar" ? "event" : "task"}
                  />
                </div>
                <div style={`view-transition-name:${vt("search-desktop")}`}>
                  <SearchButton spaceId={props.ctx.space.id} spaceName={props.ctx.space.name} variant="icon" registerCommand />
                </div>
              </AppWorkspace.SidebarIconGrid>
            </Show>

            <AppWorkspace.SidebarSection sidebarMode="expanded">
              <ViewLinks spaceId={props.ctx.space.id} query={props.ctx.query} currentView={props.ctx.currentView} variant="desktop" />
            </AppWorkspace.SidebarSection>
          </div>

          <AppWorkspace.SidebarIconGrid sidebarMode="collapsed">
            <Show when={props.ctx.canWrite}>
              <CreateItemButton
                spaceId={props.ctx.space.id}
                columns={props.ctx.columns}
                tags={props.ctx.tags}
                templates={props.ctx.space.templates}
                dateConfig={props.dateConfig}
                variant="icon"
                defaultType={props.ctx.currentView === "calendar" ? "event" : "task"}
              />
            </Show>
            <SearchButton spaceId={props.ctx.space.id} spaceName={props.ctx.space.name} variant="icon" />
            <ViewLinks spaceId={props.ctx.space.id} query={props.ctx.query} currentView={props.ctx.currentView} variant="collapsed" />
          </AppWorkspace.SidebarIconGrid>

          <div class="min-h-0 flex-1" />

          <AppWorkspace.SidebarFooter sidebarMode="expanded">
            <div class="flex flex-col gap-1">
              <div style={`view-transition-name:${vt("copy-ical-desktop")}`}>
                <CopyICalButton icalToken={props.ctx.space.icalToken} />
              </div>
              <SpaceSettingsButton
                spaceId={props.ctx.space.id}
                baseUrl={props.baseUrl}
                dateConfig={props.dateConfig}
                variant="sidebar"
                viewTransitionName={vt("settings-desktop")}
              />
            </div>
          </AppWorkspace.SidebarFooter>
          <AppWorkspace.SidebarFooter sidebarMode="collapsed">
            <AppWorkspace.SidebarIconGrid>
              <CopyICalButton icalToken={props.ctx.space.icalToken} variant="icon" />
              <SpaceSettingsButton spaceId={props.ctx.space.id} baseUrl={props.baseUrl} dateConfig={props.dateConfig} variant="icon" />
            </AppWorkspace.SidebarIconGrid>
          </AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
    </>
  );
}
