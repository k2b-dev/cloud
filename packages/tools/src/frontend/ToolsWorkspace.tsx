import { i18n } from "@k2b/stdlib";
import { AppWorkspace, useLocale } from "@k2b/ui";
import { createMemo, type JSX } from "solid-js";
import ToolSearchButton from "./ToolSearchButton.island";
import ToolsNavigation from "./ToolsNavigation.island";
import { categoryOrder, type LocalizedTool, resolveRegistry } from "./tools/registry";

export const toolsWorkspaceMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { overview: "Overview" },
    de: { overview: "Übersicht" },
  },
});

type ToolsWorkspaceProps = {
  activeToolId?: string;
  layout?: "main" | "regions";
  children: JSX.Element;
};

export const ToolsWorkspace = (props: ToolsWorkspaceProps) => {
  const locale = useLocale();
  const t = () => toolsWorkspaceMessages.resolve([locale()]).t;
  const registry = createMemo(() => resolveRegistry(locale()));

  const renderItem = (tool: LocalizedTool) => (
    <AppWorkspace.SidebarItem
      href={`/tools/${tool.id}`}
      navigation="document"
      icon={tool.icon}
      active={props.activeToolId === tool.id}
      title={tool.name}
      meta={
        tool.featured ? (
          <svg class="size-[10px] fill-current" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z" />
          </svg>
        ) : undefined
      }
    >
      {tool.name}
    </AppWorkspace.SidebarItem>
  );

  const categoryNavigation = (sidebarMode?: "expanded") => (
    <>
      {categoryOrder.map((category) => {
        const items = registry().tools.filter((tool) => tool.category === category);
        if (items.length === 0) return null;
        return (
          <AppWorkspace.SidebarSection title={registry().categories[category].label} sidebarMode={sidebarMode}>
            {items.map(renderItem)}
          </AppWorkspace.SidebarSection>
        );
      })}
    </>
  );

  return (
    <div class="flex min-h-0 min-w-0 flex-1">
      <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1">
        <ToolsNavigation overviewLabel={t().overview} activeToolId={props.activeToolId} />
        <AppWorkspace.Sidebar collapsible>
          <AppWorkspace.SidebarDesktop>
            <AppWorkspace.SidebarBody scrollPreserveKey="tools-sidebar">
              <AppWorkspace.SidebarIconGrid columns={2}>
                <AppWorkspace.SidebarIconAction
                  href="/tools"
                  navigation="document"
                  icon="ti ti-layout-grid"
                  label={t().overview}
                  active={!props.activeToolId}
                />
                <ToolSearchButton variant="icon" registerCommand />
              </AppWorkspace.SidebarIconGrid>
              {categoryNavigation("expanded")}
            </AppWorkspace.SidebarBody>
          </AppWorkspace.SidebarDesktop>
        </AppWorkspace.Sidebar>
        <AppWorkspace.Content>
          {props.layout === "regions" ? (
            props.children
          ) : (
            <AppWorkspace.Main class={props.activeToolId ? "tools-main overflow-y-auto p-[var(--ui-space-shell)]" : "overflow-y-auto"}>
              {props.children}
            </AppWorkspace.Main>
          )}
        </AppWorkspace.Content>
      </AppWorkspace>
    </div>
  );
};
