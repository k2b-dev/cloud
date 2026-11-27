import { refreshCurrentPath } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { type MenuItem, type NavGroup, type NavItem, useToast } from "@k2b/ui/v2";
import { type Accessor, createMemo } from "solid-js";
import { NavigationResourceTypeSchema, navigationReferenceKey } from "../../../navigation-contracts";
import { openDocumentTemplateEditorDialog } from "../dialogs/DocumentTemplateEditorDialog";
import { createForm, openFormEditorDialog } from "../forms/FormsManager";
import { openFormModal } from "../records/FormSubmitModal";
import { createBaseSettings } from "../sidebar/base-settings";
import { createCustomAppAction } from "../sidebar/create-custom-app";
import { createTableAction } from "../sidebar/create-table";
import { createWorkflowAction } from "../sidebar/create-workflow";
import { type NavigationResource, type NavigationState, navigationResources } from "../workspace/navigation-catalog";
import { workspaceLiveStatus } from "../workspace/workspace-live-state";
import { frameMessages } from "./messages";

type NavigationResourceType = NavigationResource["type"];

/** v2 names Tabler icons without the `ti ti-` classes v1 stores. */
export const v2Icon = (value: string | null | undefined, fallback: string) => (value ? value.replace(/^ti ti-/, "") : fallback);

export type GridsNav = {
  groups: Accessor<NavGroup[]>;
  foot: Accessor<NavItem[]>;
  /** What can be created here, for a "New" menu beside the sidebar; empty outside edit mode. */
  create: Accessor<MenuItem[]>;
  /** Opens a form of the sidebar to fill it out. */
  fillOut: (formId: string) => void;
  /** Opens a form's editor; `undefined` when this person may not edit it here. */
  editForm: (formId: string) => (() => void) | undefined;
};

/**
 * The places of a base for a v2 sidebar and the phone's menu: the base with its overview and query, then the curated
 * groups or one group per kind (tables with their views one level in), and at the foot edit mode and settings. Deeds
 * that create something live in the base's "…" while edit mode is on; links keep `?edit=true` then.
 */
export function createGridsNav(state: NavigationState): GridsNav {
  const locale = useLocale();
  const t = () => frameMessages.resolve([locale()]).t;
  const toast = useToast();
  const base = state.base.id;
  const edit = state.adminModeRequested;
  const href = (path = "") => `/app/grids/${base}${path}${edit ? "?edit=true" : ""}`;
  const resources = navigationResources(base, state.catalog, edit);
  const active = state.route.activeKey;
  const failed = (message: string) => (error: unknown) =>
    toast(error instanceof Error && error.message ? error.message : message, { status: "bad" });

  const createTable = createTableAction({ baseId: base });
  const createApp = createCustomAppAction({ baseId: base });
  const createWorkflow = createWorkflowAction({ baseId: base, tables: state.catalog.tables, fieldsByTable: state.catalog.fieldsByTable });
  const settings = createBaseSettings({ base: state.base, navigationResources: navigationResources(base, state.catalog) });

  const formOf = (id: string) => state.catalog.sidebarForms.find((entry) => entry.form.id === id);
  const fillOut = (id: string) => {
    const entry = formOf(id);
    if (!entry) return;
    void openFormModal(entry.form, state.catalog.fieldsByTable[entry.table.id] ?? [], {
      onSubmitted: refreshCurrentPath,
      dateConfig: state.dateConfig,
    }).catch(failed(t().openFormFailed));
  };
  const editForm = (id: string) => {
    const entry = formOf(id);
    if (!entry) return;
    void openFormEditorDialog({
      form: entry.form,
      tableFields: state.catalog.fieldsByTable[entry.table.id] ?? [],
      onSaved: refreshCurrentPath,
      onDelete: refreshCurrentPath,
    }).catch(failed(t().openFormFailed));
  };

  const place = (resource: NavigationResource, nested = false): NavItem => {
    const status = resource.status === "disabled" ? t().off : resource.status === "draft" ? t().draft : undefined;
    const common = {
      label: resource.name,
      icon: v2Icon(resource.icon, "table"),
      current: active === navigationReferenceKey(resource),
      nested,
    };
    if (resource.type === "form") {
      const editable = edit && state.catalog.tableLevels[formOf(resource.id)?.table.id ?? ""] === "admin";
      return {
        ...common,
        onClick: () => fillOut(resource.id),
        ...(editable ? { menu: [{ label: t().editForm, icon: "pencil", onClick: () => editForm(resource.id) }] } : {}),
      };
    }
    return {
      ...common,
      href: resource.href,
      ...(status ? { count: status } : {}),
      ...(resource.type === "customApp" && common.current
        ? {
            menu: [
              {
                label: t().settingsFor({ name: resource.name }),
                icon: "settings",
                href: `/app/grids/${base}/apps/${resource.id}?edit=true&settings=app`,
              },
            ],
          }
        : {}),
    };
  };

  /** A view whose table this person cannot open as a page of its own. */
  const orphan = (view: NavigationResource) =>
    !Object.entries(state.catalog.viewsByTable).some(
      ([tableId, list]) =>
        list.some((each) => each.id === view.id) && resources.some((each) => each.type === "table" && each.id === tableId),
    );
  /** Tables with their views one level in; views of tables not shown stand on their own. */
  const tablePlaces = (entries: NavigationResource[]): NavItem[] => {
    const tables = entries.filter((entry) => entry.type === "table");
    const views = entries.filter((entry) => entry.type === "view");
    const tableIds = new Set(tables.map((table) => table.id));
    const viewTable = (view: NavigationResource) =>
      Object.entries(state.catalog.viewsByTable).find(([, list]) => list.some((each) => each.id === view.id))?.[0];
    return [
      ...tables.flatMap((table) => [
        place(table),
        ...views.filter((view) => viewTable(view) === table.id).map((view) => place(view, true)),
      ]),
      ...views.filter((view) => !tableIds.has(viewTable(view) ?? "")).map((view) => place(view)),
    ];
  };

  const typeLabel = (type: NavigationResourceType) =>
    ({
      table: t().tables,
      view: t().views,
      form: t().forms,
      documentTemplate: t().documents,
      workflow: t().workflows,
      customApp: t().apps,
    })[type];

  /** The places of one kind, with the kind's own entry first ("All documents"). */
  const placesOf = (type: NavigationResourceType): NavItem[] => {
    const own = resources.filter((resource) => resource.type === type);
    // a table's views are the tabs in the head of its page; views of tables not shown here stand on their own
    if (type === "table")
      return tablePlaces(resources.filter((resource) => resource.type === "table" || (resource.type === "view" && orphan(resource))));
    if (type === "documentTemplate")
      return [
        { label: t().allDocuments, icon: "files", href: href("/documents"), current: active === "documentTemplate:all" },
        ...own.map((resource) => place(resource)),
      ];
    if (type === "workflow" && active === "workflow:all")
      return [
        { label: t().allWorkflows, icon: "route", href: href("/workflows"), current: true },
        ...own.map((resource) => place(resource)),
      ];
    return own.map((resource) => place(resource));
  };

  const eligible = (kind: "view" | "form" | "documentTemplate") =>
    state.catalog.tables.filter((table) => state.catalog.tableLevels[table.id] === "admin" && (kind !== "form" || table.kind === "stored"));
  const tableChoice = (kind: "view" | "form" | "documentTemplate", run: (tableId: string) => Promise<unknown>): MenuItem[] =>
    eligible(kind).map((table) => ({
      label: table.name,
      icon: v2Icon(table.icon, "table"),
      onClick: () => void run(table.id).catch(failed(t().createFailed)),
    }));
  const createView = async (tableId: string) =>
    window.location.assign(`/app/grids/${base}/table/${tableId}/query?q=${encodeURIComponent(`from table {${tableId}}`)}&edit=true`);
  const createFormIn = async (tableId: string) => {
    const fields = state.catalog.fieldsByTable[tableId] ?? [];
    const form = await createForm({ tableId, fields }, locale());
    if (!form) return;
    await openFormEditorDialog({ form, tableFields: fields, justCreated: true });
    window.location.reload();
  };
  const createTemplateIn = async (tableId: string) => {
    const table = state.catalog.tables.find((each) => each.id === tableId);
    if (!table) return;
    await openDocumentTemplateEditorDialog({
      baseId: base,
      tableId,
      tableName: table.name,
      onSaved: (template) => window.location.assign(`/app/grids/${base}/document/${tableId}/${template.id}?edit=true`),
    });
  };

  const create = createMemo((): MenuItem[] => {
    if (!edit || (!state.canCreateTables && !state.canManageBase)) return [];
    const entries: MenuItem[] = [];
    if (state.canCreateTables)
      entries.push({ label: t().newTable, icon: "table", onClick: () => void createTable().catch(failed(t().createFailed)) });
    if (eligible("view").length) entries.push({ label: t().newView, icon: "table-spark", items: tableChoice("view", createView) });
    if (eligible("form").length) entries.push({ label: t().newForm, icon: "forms", items: tableChoice("form", createFormIn) });
    if (eligible("documentTemplate").length)
      entries.push({ label: t().newDocumentTemplate, icon: "file-type-pdf", items: tableChoice("documentTemplate", createTemplateIn) });
    if (state.canManageBase) {
      entries.push({ label: t().newWorkflow, icon: "route", onClick: () => void createWorkflow().catch(failed(t().createFailed)) });
      entries.push({ label: t().newApp, icon: "app-window", onClick: () => void createApp().catch(failed(t().createFailed)) });
    }
    return entries;
  });

  const groups = createMemo((): NavGroup[] => {
    if (workspaceLiveStatus().revoked) return [];
    const head: NavGroup = {
      label: state.base.name,
      action: {
        label: t().baseActions,
        items: [
          ...(create().length ? [{ title: t().newResource, items: create() }] : []),
          { label: t().allBases, icon: "layout-grid", href: "/app/grids" },
          { label: t().newBase, icon: "plus", href: "/app/grids?new=blank" },
        ],
      },
      items: [
        { label: t().overview, icon: "layout-dashboard", href: href(), current: state.route.kind === "overview" },
        ...(state.canUseQueryWorkspace
          ? [{ label: t().query, icon: "code", href: `/app/grids/${base}/query`, current: state.route.kind === "query" }]
          : []),
      ],
    };
    const curated = state.navigation?.groups ?? [];
    if (curated.length) {
      const byKey = new Map(resources.map((resource) => [navigationReferenceKey(resource), resource]));
      return [
        head,
        // a group without anything this person can open stays hidden
        ...curated
          .map((group) => ({
            label: group.name,
            items: group.entries.flatMap((entry) => {
              const resource = byKey.get(navigationReferenceKey(entry));
              return resource ? [place(resource)] : [];
            }),
          }))
          .filter((group) => group.items.length > 0),
        {
          label: t().allResources,
          // k2b-ui gap: a folding Nav entry cannot be told to stay open; v1 remembered each fold per base in a cookie.
          items: NavigationResourceTypeSchema.options
            .filter((type) => type !== "view" && placesOf(type).length > 0)
            .map((type) => ({ label: typeLabel(type), items: placesOf(type) })),
        },
      ];
    }
    return [
      head,
      ...NavigationResourceTypeSchema.options
        .filter((type) => type !== "view")
        .map((type) => ({ label: typeLabel(type), items: placesOf(type) }))
        .filter((group) => group.items.length > 0),
    ];
  });

  const foot = createMemo((): NavItem[] => [
    ...(state.canUseEditMode
      ? [{ label: edit ? t().doneEditing : t().editMode, icon: edit ? "check" : "tool", href: state.editModeToggleHref }]
      : []),
    ...(state.canManageBase ? [{ label: t().settings, icon: "settings", onClick: () => void settings.showSettings() }] : []),
  ]);

  const editableForm = (id: string) => edit && state.catalog.tableLevels[formOf(id)?.table.id ?? ""] === "admin";
  return { groups, foot, create, fillOut, editForm: (id) => (editableForm(id) ? () => editForm(id) : undefined) };
}
