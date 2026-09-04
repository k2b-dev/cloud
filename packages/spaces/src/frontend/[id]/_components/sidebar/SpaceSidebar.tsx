import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace } from "@k2b/ui";
import { Show } from "solid-js";
import { useSpaceMessages } from "../../messages";
import SearchButton from "../search/SearchButton.island";
import CopyICalButton from "./CopyICalButton.island";
import CreateItemButton from "./CreateItemButton.island";
import SpaceSettingsButton from "./SpaceSettingsButton.island";
import type { SpaceContext } from "./types";
import ViewLinks from "./ViewLinks.island";

type Props = {
  ctx: SpaceContext;
  baseUrl: string;
  dateConfig?: DateContext;
};

export default function SpaceSidebar(props: Props) {
  const t = useSpaceMessages();
  const vt = (key: string) => `space-sidebar-${props.ctx.space.id}-${key}`;

  return (
    <AppWorkspace.Sidebar collapsible>
      <AppWorkspace.SidebarMobileTrigger label={props.ctx.space.name} />

      <AppWorkspace.SidebarMobile>
        <AppWorkspace.SidebarMobileItems scrollPreserveKey={`spaces-sidebar-mobile-${props.ctx.space.id}`}>
          <Show when={props.ctx.canWrite}>
            <div style={`view-transition-name:${vt("create-mobile")}`}>
              <CreateItemButton
                spaceId={props.ctx.space.id}
                columns={props.ctx.columns}
                tags={props.ctx.tags}
                dateConfig={props.dateConfig}
                variant="chip"
                defaultType={props.ctx.currentView === "calendar" ? "event" : "task"}
              />
            </div>
          </Show>
          <div style={`view-transition-name:${vt("search-mobile")}`}>
            <SearchButton
              spaceId={props.ctx.space.id}
              spaceName={props.ctx.space.name}
              columns={props.ctx.columns}
              query={props.ctx.query}
              variant="sidebar-mobile"
            />
          </div>
          <AppWorkspace.SidebarItem
            href="/app/spaces"
            navigation="document"
            icon="ti ti-layout-grid"
            viewTransitionName={vt("all-spaces-mobile")}
          >
            {t.allSpaces}
          </AppWorkspace.SidebarItem>
          <ViewLinks spaceId={props.ctx.space.id} query={props.ctx.query} currentView={props.ctx.currentView} variant="mobile" />
          <div style={`view-transition-name:${vt("copy-ical-mobile")}`}>
            <CopyICalButton icalToken={props.ctx.space.icalToken} variant="chip" />
          </div>
          <SpaceSettingsButton
            spaceId={props.ctx.space.id}
            baseUrl={props.baseUrl}
            variant="sidebar"
            viewTransitionName={vt("settings-mobile")}
          />
        </AppWorkspace.SidebarMobileItems>
      </AppWorkspace.SidebarMobile>

      <AppWorkspace.SidebarDesktop>
        <div class="flex flex-col gap-3">
          <AppWorkspace.SidebarIconGrid columns={props.ctx.canWrite ? 3 : 2} sidebarMode="expanded">
            <Show when={props.ctx.canWrite}>
              <div style={`view-transition-name:${vt("create-desktop")}`}>
                <CreateItemButton
                  spaceId={props.ctx.space.id}
                  columns={props.ctx.columns}
                  tags={props.ctx.tags}
                  dateConfig={props.dateConfig}
                  variant="icon"
                  registerShortcut
                  defaultType={props.ctx.currentView === "calendar" ? "event" : "task"}
                />
              </div>
            </Show>
            <div style={`view-transition-name:${vt("search-desktop")}`}>
              <SearchButton
                spaceId={props.ctx.space.id}
                spaceName={props.ctx.space.name}
                columns={props.ctx.columns}
                query={props.ctx.query}
                variant="icon"
                registerShortcut
              />
            </div>
            <AppWorkspace.SidebarIconAction
              href="/app/spaces"
              navigation="document"
              icon="ti ti-layout-grid"
              label={t.allSpaces}
              viewTransitionName={vt("all-spaces-desktop")}
            />
          </AppWorkspace.SidebarIconGrid>

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
              dateConfig={props.dateConfig}
              variant="icon"
              defaultType={props.ctx.currentView === "calendar" ? "event" : "task"}
            />
          </Show>
          <SearchButton
            spaceId={props.ctx.space.id}
            spaceName={props.ctx.space.name}
            columns={props.ctx.columns}
            query={props.ctx.query}
            variant="icon"
          />
          <AppWorkspace.SidebarIconAction href="/app/spaces" navigation="document" icon="ti ti-layout-grid" label={t.allSpaces} />
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
              variant="sidebar"
              viewTransitionName={vt("settings-desktop")}
            />
          </div>
        </AppWorkspace.SidebarFooter>
        <AppWorkspace.SidebarFooter sidebarMode="collapsed">
          <AppWorkspace.SidebarIconGrid>
            <CopyICalButton icalToken={props.ctx.space.icalToken} variant="icon" />
            <SpaceSettingsButton spaceId={props.ctx.space.id} baseUrl={props.baseUrl} variant="icon" />
          </AppWorkspace.SidebarIconGrid>
        </AppWorkspace.SidebarFooter>
      </AppWorkspace.SidebarDesktop>
    </AppWorkspace.Sidebar>
  );
}
