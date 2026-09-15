import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { createNavigation, type NavigationItem, prompts, useLocale } from "@k2b/ui";
import { NavigationResourceTypeSchema, navigationReferenceKey } from "../../../navigation-contracts";
import { navigationMessages } from "../../../navigation-messages";
import { createBaseSettings } from "../sidebar/base-settings";
import { createNewResource } from "../sidebar/new-resource";
import { sidebarMessages } from "../sidebar/messages";
import { openSidebarForm } from "../sidebar/open-sidebar-form";
import { workspaceMessages } from "./messages";
import { activeNavigationKey, navigationResources, type NavigationResource } from "./navigation-catalog";
import type { PublicOkWorkspaceState } from "./workspace-public-state-model";

export default function GridsNavigation(props: { state: PublicOkWorkspaceState }) {
  const locale = useLocale();
  const t = () => workspaceMessages.resolve([locale()]).t;
  const navText = () => navigationMessages.resolve([locale()]).t;
  const state = props.state;
  const resources = navigationResources(state.base.id, state.catalog, state.adminModeRequested);
  const settings = createBaseSettings({ base: state.base, navigationResources: navigationResources(state.base.id, state.catalog) });
  const create = createNewResource({
    baseId: state.base.id,
    tables: state.catalog.tables,
    fieldsByTable: state.catalog.fieldsByTable,
    tableLevels: state.catalog.tableLevels,
    canCreateTables: state.canCreateTables,
    canManageBase: state.canManageBase,
    activeTableId:
      state.route.kind === "records"
        ? state.route.activeTable.id
        : state.route.kind === "queryResultView"
          ? state.route.activeView.tableId
          : undefined,
  });
  const href = (suffix = "") => `/app/grids/${state.base.id}${suffix}${state.adminModeRequested ? "?edit=true" : ""}`;
  const entry = (resource: NavigationResource, parent: string): NavigationItem => ({
    id: `${parent}/${navigationReferenceKey(resource)}`,
    label: resource.name,
    icon: resource.icon,
    ...(resource.href ? { href: resource.href } : { action: `form:${resource.id}` }),
    description: [resource.context, resource.status ? t()[resource.status] : undefined].filter(Boolean).join(" · "),
    active: activeNavigationKey(state.route) === navigationReferenceKey(resource),
    actions:
      resource.type === "customApp" && activeNavigationKey(state.route) === navigationReferenceKey(resource)
        ? [
            {
              id: `${parent}/settings:${resource.id}`,
              label: t().settingsFor({ name: resource.name }),
              icon: "ti ti-settings",
              href: `/app/grids/${state.base.id}/apps/${resource.id}?edit=true&settings=app`,
            },
          ]
        : undefined,
  });
  const typeLabels = () => ({
    table: t().tables,
    view: t().views,
    form: t().forms,
    documentTemplate: t().documents,
    workflow: t().workflows,
    customApp: t().apps,
  });
  const navigation = createNavigation({
    items: () => [
      { id: "all", href: "/app/grids", label: t().allGrids, icon: "ti ti-layout-grid" },
      { id: "overview", href: href(), label: navText().overview, icon: "ti ti-layout-dashboard", active: state.route.kind === "overview" },
      ...(state.canUseQueryWorkspace
        ? [
            {
              id: "query",
              href: `/app/grids/${state.base.id}/query`,
              label: t().query,
              icon: "ti ti-code",
              active: state.route.kind === "query",
            },
          ]
        : []),
      ...(state.canUseEditMode
        ? [
            {
              id: "edit",
              href: state.editModeToggleHref,
              label: state.adminModeRequested ? t().doneEditing : t().editMode,
              icon: state.adminModeRequested ? "ti ti-check" : "ti ti-tool",
            },
          ]
        : []),
      ...(state.adminModeRequested && create.choices.length
        ? [{ id: "new", action: "new", label: navText().newResource, icon: "ti ti-plus", disabled: create.busy() }]
        : []),
      ...(state.navigation?.groups ?? []).map((group) => ({
        id: `group:${group.id}`,
        label: group.name,
        icon: "ti ti-folder",
        children: group.entries.flatMap((ref) => {
          const resource = resources.find((item) => navigationReferenceKey(item) === navigationReferenceKey(ref));
          return resource ? [entry(resource, `group:${group.id}`)] : [];
        }),
      })),
      ...NavigationResourceTypeSchema.options
        .filter((type) => type === "documentTemplate" || resources.some((item) => item.type === type))
        .map((type) => ({
          id: `type:${type}`,
          label: typeLabels()[type],
          children: [
            ...(type === "documentTemplate"
              ? [
                  {
                    id: "documents",
                    label: t().allDocuments,
                    icon: "ti ti-files",
                    href: href("/documents"),
                    active: state.route.kind === "documents",
                  },
                ]
              : []),
            ...resources.filter((item) => item.type === type).map((item) => entry(item, `type:${type}`)),
          ],
        })),
      ...(state.canManageBase
        ? [
            {
              id: "settings",
              action: "settings",
              label: sidebarMessages.resolve([locale()]).t.settings,
              icon: "ti ti-settings",
              disabled: settings.open(),
            },
          ]
        : []),
    ],
    onAction: async (action) => {
      if (action === "new") {
        await create.open();
        return;
      }
      if (action === "settings") {
        await settings.showSettings();
        return;
      }
      const form = state.catalog.sidebarForms.find((entry) => `form:${entry.form.id}` === action)?.form;
      if (!form) return;
      const formText = sidebarMessages.resolve([locale()]).t;
      try {
        await openSidebarForm(
          {
            form,
            fields: state.catalog.fieldsByTable[form.tableId] ?? [],
            editMode: state.adminModeRequested && state.catalog.tableLevels[form.tableId] === "admin",
            dateConfig: state.dateConfig,
          },
          formText,
        );
      } catch (error) {
        await prompts.error(error instanceof Error ? error.message : formText.openFormEditorFailed);
      }
    },
  });
  return <WorkspaceNavigationProvider navigation={navigation} label={state.base.name} />;
}
