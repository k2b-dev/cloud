import { AppWorkspace, useLocale } from "@k2b/ui";
import { navigationMessages } from "../../../navigation-messages";
import BaseSettingsButton from "../sidebar/BaseSettingsButton.island";
import FormSidebarEntry from "../sidebar/FormSidebarEntry.island";
import NewResourceButton from "../sidebar/NewResourceButton.island";
import SidebarTableMeta from "../sidebar/SidebarTableMeta";
import GroupedNavigation from "./GroupedNavigation.island";
import { workspaceMessages } from "./messages";
import { activeNavigationKey, navigationResources } from "./navigation-catalog";
import type {
  PublicOkWorkspaceState,
  PublicWorkspaceQueryResultViewRoute,
  PublicWorkspaceRecordsRoute,
} from "./workspace-public-state-model";

type PublicWorkspaceWorkflowsRoute = Extract<PublicOkWorkspaceState["route"], { kind: "workflows" }>;

const urlWithParam = (href: string, key: string, value: string) => {
  const url = new URL(href, "http://grids.local");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
};

const keepEdit = (href: string, editMode: boolean) => (editMode ? urlWithParam(href, "edit", "true") : href);

const itemClass = (active: boolean, editMode: boolean) => (!active && editMode ? "text-secondary" : undefined);

const SidebarLink = (props: Parameters<typeof AppWorkspace.SidebarItem>[0]) => (
  <AppWorkspace.SidebarItem {...props} navigation="document" />
);

export default function GridsSidebar(props: { state: PublicOkWorkspaceState }) {
  const { t } = workspaceMessages.resolve([useLocale()()]);
  const state = props.state;
  const { t: navText } = navigationMessages.resolve([useLocale()()]);
  const route = state.route;
  const recordsRoute = route.kind === "records" ? (route as PublicWorkspaceRecordsRoute) : null;
  const queryResultViewRoute = route.kind === "queryResultView" ? (route as PublicWorkspaceQueryResultViewRoute) : null;
  const workflowsRoute = route.kind === "workflows" ? (route as PublicWorkspaceWorkflowsRoute) : null;
  const activeCustomAppId = route.kind === "customApp" ? route.app.id : null;
  const createButton = () =>
    state.adminModeRequested && (state.canCreateTables || state.canManageBase) ? (
      <NewResourceButton
        baseId={state.base.id}
        tables={state.catalog.tables}
        fieldsByTable={state.catalog.fieldsByTable}
        tableLevels={state.catalog.tableLevels}
        canCreateTables={state.canCreateTables}
        canManageBase={state.canManageBase}
        activeTableId={recordsRoute?.activeTable.id ?? queryResultViewRoute?.activeView.tableId}
      />
    ) : null;
  const documentNavigation = () => (
    <GroupedNavigation
      baseId={state.base.id}
      groups={[]}
      resources={navigationResources(state.base.id, state.catalog, state.adminModeRequested)}
      active={activeNavigationKey(route)}
      initialExpanded={state.initialNavigationExpansion}
      forms={state.catalog.sidebarForms}
      fields={state.catalog.fieldsByTable}
      editMode={state.adminModeRequested}
      dateConfig={state.dateConfig}
    />
  );
  const sidebarViews = state.catalog.tables.flatMap((table) =>
    (state.catalog.viewsByTable[table.id] ?? []).map((view) => ({ table, view })),
  );
  const renderQueryItem = () =>
    state.canUseQueryWorkspace ? (
      <SidebarLink href={`/app/grids/${state.base.id}/query`} active={route.kind === "query"}>
        <AppWorkspace.SidebarItemIcon icon="ti ti-code" />
        <AppWorkspace.SidebarItemLabel>{t.query}</AppWorkspace.SidebarItemLabel>
      </SidebarLink>
    ) : null;

  const overviewLink = () => (
    <SidebarLink href={keepEdit(`/app/grids/${state.base.id}`, state.adminModeRequested)} active={route.kind === "overview"}>
      <AppWorkspace.SidebarItemIcon icon="ti ti-layout-dashboard" />
      <AppWorkspace.SidebarItemLabel>{navText.overview}</AppWorkspace.SidebarItemLabel>
    </SidebarLink>
  );
  const navigation = () =>
    state.navigation?.groups.length ? (
      <>
        <GroupedNavigation
          baseId={state.base.id}
          groups={state.navigation.groups}
          resources={navigationResources(state.base.id, state.catalog, state.adminModeRequested)}
          active={activeNavigationKey(route)}
          initialExpanded={state.initialNavigationExpansion}
          forms={state.catalog.sidebarForms}
          fields={state.catalog.fieldsByTable}
          editMode={state.adminModeRequested}
          dateConfig={state.dateConfig}
        />
      </>
    ) : (
      renderNavigationSections()
    );

  const renderNavigationSections = () => (
    <>
      <AppWorkspace.SidebarSection title={t.tables}>
        {state.catalog.tables.length === 0 ? (
          <p class="px-2 py-1 text-xs text-dimmed">
            {state.catalog.sidebarForms.length > 0 || state.catalog.sidebarDocumentTemplates.length > 0 ? t.noTableAccessShort : t.noTables}
          </p>
        ) : (
          state.catalog.tables.map((table) => {
            const active = recordsRoute?.activeTable.id === table.id && recordsRoute.activeView === null;
            return (
              <SidebarLink
                href={keepEdit(`/app/grids/${state.base.id}/table/${table.id}`, state.adminModeRequested)}
                active={active}
                class={itemClass(active, state.adminModeRequested)}
                title={table.name}
              >
                <AppWorkspace.SidebarItemIcon icon={table.icon ?? "ti ti-table"} />
                <AppWorkspace.SidebarItemLabel>{table.name}</AppWorkspace.SidebarItemLabel>
              </SidebarLink>
            );
          })
        )}
      </AppWorkspace.SidebarSection>

      {sidebarViews.length > 0 && (
        <AppWorkspace.SidebarSection title={t.views}>
          {sidebarViews.map(({ table, view }) => {
            const active =
              (recordsRoute?.activeTable.id === table.id && recordsRoute.activeView?.id === view.id) ||
              queryResultViewRoute?.activeView.id === view.id;
            return (
              <SidebarLink
                href={keepEdit(`/app/grids/${state.base.id}/table/${table.id}/view/${view.id}`, state.adminModeRequested)}
                active={active}
                class={itemClass(active, state.adminModeRequested)}
                title={t.tableContext({ name: view.name, table: table.name })}
              >
                <AppWorkspace.SidebarItemIcon icon={view.icon ?? "ti ti-table-spark"} />
                <AppWorkspace.SidebarItemLabel>{view.name}</AppWorkspace.SidebarItemLabel>
                <SidebarTableMeta tableName={table.name} />
              </SidebarLink>
            );
          })}
        </AppWorkspace.SidebarSection>
      )}

      {state.catalog.sidebarForms.length > 0 && (
        <AppWorkspace.SidebarSection title={t.forms}>
          {state.catalog.sidebarForms.map(({ form, table }) => (
            <FormSidebarEntry
              form={form}
              tableName={table.name}
              fields={state.catalog.fieldsByTable[table.id] ?? []}
              editMode={state.adminModeRequested && state.catalog.tableLevels[table.id] === "admin"}
              dateConfig={state.dateConfig}
            />
          ))}
        </AppWorkspace.SidebarSection>
      )}

      {documentNavigation()}

      {state.catalog.workflows.length > 0 && (
        <AppWorkspace.SidebarSection title={t.workflows}>
          {state.catalog.workflows.map((workflow) => {
            const active = workflowsRoute?.activeWorkflow?.id === workflow.id;
            return (
              <SidebarLink
                href={keepEdit(`/app/grids/${state.base.id}/workflows/${workflow.id}`, state.adminModeRequested)}
                active={active}
                class={itemClass(active, state.adminModeRequested)}
                title={workflow.name}
              >
                <AppWorkspace.SidebarItemIcon icon="ti ti-route" />
                <AppWorkspace.SidebarItemLabel>{workflow.name}</AppWorkspace.SidebarItemLabel>
                {!workflow.enabled && (
                  <AppWorkspace.SidebarItemMeta>
                    <span class="text-[9px] uppercase tracking-wider text-dimmed">{t.disabled}</span>
                  </AppWorkspace.SidebarItemMeta>
                )}
              </SidebarLink>
            );
          })}
        </AppWorkspace.SidebarSection>
      )}

      {state.catalog.customApps.length > 0 && (
        <AppWorkspace.SidebarSection title={t.apps}>
          {state.catalog.customApps.map((app) => (
            <SidebarLink
              href={keepEdit(`/app/grids/${state.base.id}/apps/${app.id}`, state.adminModeRequested)}
              active={activeCustomAppId === app.id}
              title={app.name}
            >
              <AppWorkspace.SidebarItemIcon icon={app.icon ? `ti ti-${app.icon}` : "ti ti-app-window"} />
              <AppWorkspace.SidebarItemLabel>{app.name}</AppWorkspace.SidebarItemLabel>
              {!app.publishedAt && (
                <AppWorkspace.SidebarItemMeta>
                  <span class="text-[9px] uppercase tracking-wider text-dimmed">{t.draft}</span>
                </AppWorkspace.SidebarItemMeta>
              )}
              {activeCustomAppId === app.id && (
                <AppWorkspace.SidebarItemAction
                  icon="ti ti-settings"
                  label={t.settingsFor({ name: app.name })}
                  href={`/app/grids/${state.base.id}/apps/${app.id}?edit=true&settings=app`}
                  navigation="document"
                />
              )}
            </SidebarLink>
          ))}
        </AppWorkspace.SidebarSection>
      )}
    </>
  );

  return (
    <AppWorkspace.Sidebar>
      <AppWorkspace.SidebarMobileTrigger label={state.base.name} />
      <AppWorkspace.SidebarMobile>
        <AppWorkspace.SidebarMobileItems scrollPreserveKey={`grids-sidebar-mobile-${state.base.id}`}>
          {state.canUseEditMode && (
            <SidebarLink
              href={state.editModeToggleHref}
              tone={state.adminModeRequested ? "success" : undefined}
              class={state.adminModeRequested ? "font-medium" : undefined}
            >
              <AppWorkspace.SidebarItemIcon icon={state.adminModeRequested ? "ti ti-check" : "ti ti-tool"} />
              <AppWorkspace.SidebarItemLabel>{state.adminModeRequested ? t.doneEditing : t.editMode}</AppWorkspace.SidebarItemLabel>
            </SidebarLink>
          )}
          <SidebarLink href="/app/grids">
            <AppWorkspace.SidebarItemIcon icon="ti ti-layout-grid" />
            <AppWorkspace.SidebarItemLabel>{t.allGrids}</AppWorkspace.SidebarItemLabel>
          </SidebarLink>
          {renderQueryItem()}
          {overviewLink()}
          {createButton()}
          {state.canManageBase && (
            <BaseSettingsButton base={state.base} navigationResources={navigationResources(state.base.id, state.catalog)} />
          )}
        </AppWorkspace.SidebarMobileItems>
        <AppWorkspace.SidebarMobileBody
          class="!max-h-[min(40rem,calc(100dvh-14rem))]"
          scrollPreserveKey={`grids-sidebar-mobile-body-${state.base.id}`}
        >
          {navigation()}
        </AppWorkspace.SidebarMobileBody>
      </AppWorkspace.SidebarMobile>
      <AppWorkspace.SidebarDesktop>
        <AppWorkspace.SidebarSection>
          <SidebarLink href="/app/grids">
            <AppWorkspace.SidebarItemIcon icon="ti ti-layout-grid" />
            <AppWorkspace.SidebarItemLabel>{t.allGrids}</AppWorkspace.SidebarItemLabel>
          </SidebarLink>
          {renderQueryItem()}
          {overviewLink()}
          {createButton()}
        </AppWorkspace.SidebarSection>
        <AppWorkspace.SidebarBody scrollPreserveKey="grids-sidebar">{navigation()}</AppWorkspace.SidebarBody>
        {(state.canUseEditMode || state.canManageBase) && (
          <AppWorkspace.SidebarFooter>
            {state.canUseEditMode && (
              <SidebarLink
                href={state.editModeToggleHref}
                tone={state.adminModeRequested ? "success" : undefined}
                class={state.adminModeRequested ? "font-medium" : undefined}
              >
                <AppWorkspace.SidebarItemIcon icon={state.adminModeRequested ? "ti ti-check" : "ti ti-tool"} />
                <AppWorkspace.SidebarItemLabel>{state.adminModeRequested ? t.doneEditing : t.editMode}</AppWorkspace.SidebarItemLabel>
              </SidebarLink>
            )}
            {state.canManageBase && (
              <BaseSettingsButton base={state.base} navigationResources={navigationResources(state.base.id, state.catalog)} />
            )}
          </AppWorkspace.SidebarFooter>
        )}
      </AppWorkspace.SidebarDesktop>
    </AppWorkspace.Sidebar>
  );
}
