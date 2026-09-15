import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { createNavigation } from "@k2b/ui";
import type { CustomAppDefinition } from "../../custom-apps/contracts";
import { customAppPageHref } from "../../custom-apps/routing";
import { openCustomAppSidebarForm, type CustomAppRenderedSidebarAction } from "./sidebar-form";

export default function CustomAppNavigation(props: {
  definition: CustomAppDefinition;
  appId: string;
  pageId: string;
  actions: CustomAppRenderedSidebarAction[];
}) {
  const navigation = createNavigation({
    items: () => [
      ...props.actions.map((action) => ({
        id: `action:${action.id}`,
        action: action.id,
        label: action.label,
        icon: `ti ti-${action.icon ?? "forms"}`,
      })),
      ...props.definition.pages
        .filter((page) => page.navigation.visible)
        .map((page) => ({
          id: page.id,
          label: page.title,
          icon: `ti ti-${page.navigation.icon ?? "file"}`,
          href: customAppPageHref(props.appId, page.id),
          active: page.id === props.pageId,
        })),
    ],
    onAction: async (id) => {
      const action = props.actions.find((item) => item.id === id);
      if (action) await openCustomAppSidebarForm(action);
    },
  });
  return <WorkspaceNavigationProvider navigation={navigation} label={props.definition.name} />;
}
