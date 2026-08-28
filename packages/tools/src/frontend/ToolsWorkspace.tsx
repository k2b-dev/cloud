import { i18n } from "@k2b/stdlib";
import { AppWorkspace, useLocale } from "@k2b/ui";
import { createMemo, type JSX } from "solid-js";
import ToolSearchButton from "./ToolSearchButton.island";
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
      meta={tool.featured ? <i class="ti ti-star-filled text-[10px]" /> : undefined}
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
      <AppWorkspace class="min-h-0 flex-1">
        <AppWorkspace.Sidebar collapsible>
          <AppWorkspace.SidebarMobileTrigger label="Tools" />
          <AppWorkspace.SidebarMobile>
            <AppWorkspace.SidebarMobileItems scrollPreserveKey="tools-sidebar-mobile">
              <AppWorkspace.SidebarItem href="/tools" navigation="document" icon="ti ti-layout-grid" active={!props.activeToolId}>
                {t().overview}
              </AppWorkspace.SidebarItem>
              <ToolSearchButton variant="sidebar-mobile" />
              {registry()
                .tools.filter((tool) => tool.featured)
                .map(renderItem)}
            </AppWorkspace.SidebarMobileItems>
            <AppWorkspace.SidebarMobileBody scrollPreserveKey="tools-sidebar-mobile-body">
              {categoryNavigation()}
            </AppWorkspace.SidebarMobileBody>
          </AppWorkspace.SidebarMobile>
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
                <ToolSearchButton variant="icon" registerShortcut />
              </AppWorkspace.SidebarIconGrid>
              {categoryNavigation("expanded")}
            </AppWorkspace.SidebarBody>
          </AppWorkspace.SidebarDesktop>
        </AppWorkspace.Sidebar>
        <AppWorkspace.Content>
          {props.layout === "regions" ? (
            props.children
          ) : (
            <AppWorkspace.Main
              class={props.activeToolId ? "tools-main overflow-y-auto p-[var(--ui-space-shell)]" : "tools-main overflow-y-auto"}
            >
              {props.children}
            </AppWorkspace.Main>
          )}
        </AppWorkspace.Content>
      </AppWorkspace>
    </div>
  );
};
