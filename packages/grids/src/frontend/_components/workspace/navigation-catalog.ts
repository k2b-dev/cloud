import { type NavigationReference, navigationReferenceKey } from "../../../navigation-contracts";
import type { PublicOkWorkspaceState, PublicWorkspaceCatalog } from "./workspace-public-state-model";

export type NavigationResource = NavigationReference & {
  name: string;
  icon: string;
  context?: string;
  href?: string;
  status?: "draft" | "disabled";
};

/** One catalog of destinations for the overview, curated groups, and their editor. */
export const navigationResources = (baseId: string, catalog: PublicWorkspaceCatalog, editMode = false): NavigationResource[] => {
  const root = `/app/grids/${baseId}`;
  const href = (path: string) => `${root}${path}${editMode ? "?edit=true" : ""}`;
  return [
    ...catalog.tables.map(
      (table): NavigationResource => ({
        type: "table",
        id: table.id,
        name: table.name,
        icon: table.icon ?? "ti ti-table",
        href: href(`/table/${table.id}`),
      }),
    ),
    ...Object.values(catalog.viewsByTable)
      .flat()
      .map(
        (view): NavigationResource => ({
          type: "view",
          id: view.id,
          name: view.name,
          icon: view.icon ?? "ti ti-table-spark",
          context: catalog.tables.find((table) => table.id === view.tableId)?.name,
          href: href(`/table/${view.tableId}/view/${view.id}`),
        }),
      ),
    ...catalog.sidebarForms.flatMap(({ form, table }): NavigationResource[] =>
      form.id ? [{ type: "form", id: form.id, name: form.name ?? table.name, icon: "ti ti-forms", context: table.name }] : [],
    ),
    ...catalog.sidebarDocumentTemplates.map(
      ({ template, table }): NavigationResource => ({
        type: "documentTemplate",
        id: template.id,
        name: template.name,
        icon: "ti ti-file-type-pdf",
        context: table.name,
        href: href(`/document/${table.id}/${template.id}`),
      }),
    ),
    ...catalog.workflows.map(
      (workflow): NavigationResource => ({
        type: "workflow",
        id: workflow.id,
        name: workflow.name,
        icon: "ti ti-route",
        href: href(`/workflows/${workflow.id}`),
        status: workflow.enabled ? undefined : "disabled",
      }),
    ),
    ...catalog.customApps.map(
      (app): NavigationResource => ({
        type: "customApp",
        id: app.id,
        name: app.name,
        icon: app.icon ? `ti ti-${app.icon}` : "ti ti-app-window",
        href: href(`/apps/${app.id}`),
        status: app.publishedAt ? undefined : "draft",
      }),
    ),
  ];
};

export const activeNavigationKey = (route: PublicOkWorkspaceState["route"]): string | null => {
  if (route.kind === "documents") return "documentTemplate:all";
  if (route.kind === "records")
    return navigationReferenceKey(
      route.activeView ? { type: "view", id: route.activeView.id } : { type: "table", id: route.activeTable.id },
    );
  if (route.kind === "queryResultView") return navigationReferenceKey({ type: "view", id: route.activeView.id });
  if (route.kind === "documentTemplate") return navigationReferenceKey({ type: "documentTemplate", id: route.template.id });
  if (route.kind === "customApp") return navigationReferenceKey({ type: "customApp", id: route.app.id });
  if (route.kind === "workflows" && route.activeWorkflow) return navigationReferenceKey({ type: "workflow", id: route.activeWorkflow.id });
  return null;
};
