import { AppWorkspace, DataTable, type DataTableColumn, IconButtonLink, Pagination, Placeholder, StatusBadge } from "@k2b/ui";
import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { SearchBar } from "@valentinkolb/cloud/ssr/islands";
import { For, Show } from "solid-js";
import { type CapabilityAppSummary, loadCapabilityWorkspace, type SelectedCapability, selectCapability } from "../catalog";
import { ssr } from "../config";
import { type CapabilityKind, type CapabilitySortKey, capabilityHref, capabilityPaginationBaseHref } from "../routes";
import {
  type CapabilityOperationRow,
  type CapabilityTableState,
  capabilityOperationRows,
  paginateCapabilityOperations,
  parseCapabilityTableState,
} from "../workspace-data";
import CapabilitiesWorkspace from "./CapabilitiesWorkspace.island";
import CapabilitySearchButton, { type CapabilitySearchEntry } from "./CapabilitySearchButton.island";
import { capabilityUiMessages } from "./messages";

const columns = (t: ReturnType<typeof capabilityUiMessages.resolve>["t"]): DataTableColumn<CapabilityOperationRow>[] => [
  { id: "kind", header: t.type, value: "kind", sortable: true, class: "w-28" },
  { id: "title", header: t.capability, value: "title", sortable: true },
  { id: "id", header: "ID", value: "id", sortable: true, class: "w-72" },
  { id: "policy", header: t.policy, value: "policy", sortable: true, class: "w-40" },
  { id: "open", header: "", class: "w-14" },
];

const stateParams = (state: CapabilityTableState) => ({
  search: state.search || undefined,
  sort: state.sort,
  direction: state.direction,
});

const selectedParams = (selection: SelectedCapability | undefined) => ({
  kind: selection?.kind,
  capabilityId: selection?.operation.localId,
});

const capabilityRowHref = (appId: string, row: CapabilityOperationRow, state: CapabilityTableState): string =>
  capabilityHref({
    appId,
    kind: row.kind,
    capabilityId: row.localId,
    ...stateParams(state),
    page: state.page,
  });

const capabilitySearchEntries = (
  apps: readonly CapabilityAppSummary[],
  selectedAppId: string,
  operations: readonly CapabilityOperationRow[],
): CapabilitySearchEntry[] => [
  ...apps.map((app) => ({
    href: capabilityHref({ appId: app.id }),
    label: app.name,
    description: app.description,
    icon: app.icon || "ti ti-apps",
  })),
  ...operations.map((operation) => ({
    href: capabilityHref({ appId: selectedAppId, kind: operation.kind, capabilityId: operation.localId }),
    label: operation.title,
    description: `${operation.kind === "query" ? "Query" : "Action"} · ${operation.description}`,
    icon: operation.kind === "query" ? "ti ti-search" : "ti ti-bolt",
  })),
];

function CapabilitiesSidebar(props: {
  apps: readonly CapabilityAppSummary[];
  selectedAppId: string;
  searchEntries: CapabilitySearchEntry[];
  labels: ReturnType<typeof capabilityUiMessages.resolve>["t"];
}) {
  const renderApp = (app: CapabilityAppSummary) => (
    <AppWorkspace.SidebarItem
      href={capabilityHref({ appId: app.id })}
      navigation="document"
      icon={app.icon || "ti ti-apps"}
      active={app.id === props.selectedAppId}
      title={app.description}
    >
      {app.name}
    </AppWorkspace.SidebarItem>
  );

  return (
    <AppWorkspace.Sidebar>
      <AppWorkspace.SidebarMobileTrigger label={props.labels.capabilities} />

      <AppWorkspace.SidebarMobile>
        <AppWorkspace.SidebarMobileItems scrollPreserveKey="capabilities-apps-mobile">
          <CapabilitySearchButton entries={props.searchEntries} variant="sidebar-mobile" />
          <For each={props.apps}>{renderApp}</For>
        </AppWorkspace.SidebarMobileItems>
      </AppWorkspace.SidebarMobile>

      <AppWorkspace.SidebarDesktop>
        <AppWorkspace.SidebarBody scrollPreserveKey="capabilities-apps-sidebar">
          <AppWorkspace.SidebarSection>
            <CapabilitySearchButton entries={props.searchEntries} variant="sidebar" registerShortcut />
          </AppWorkspace.SidebarSection>
          <AppWorkspace.SidebarSection title={props.labels.apps}>
            <For each={props.apps}>{renderApp}</For>
          </AppWorkspace.SidebarSection>
        </AppWorkspace.SidebarBody>
      </AppWorkspace.SidebarDesktop>
    </AppWorkspace.Sidebar>
  );
}

function CapabilityTable(props: {
  app: CapabilityAppSummary;
  operations: readonly CapabilityOperationRow[];
  state: CapabilityTableState;
  selection?: SelectedCapability;
  labels: ReturnType<typeof capabilityUiMessages.resolve>["t"];
}) {
  const result = paginateCapabilityOperations(props.operations, props.state);
  const route = {
    appId: props.app.id,
    ...selectedParams(props.selection),
  };
  const effectiveState = { ...props.state, page: result.page };
  const closePreservingState = stateParams(effectiveState);
  const selectedRowId = props.selection ? `${props.selection.kind}:${props.selection.operation.localId}` : null;

  return (
    <DataTable.Panel class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <DataTable.Header
        title={props.app.name}
        subtitle={
          props.state.search
            ? props.labels.filteredCount({ shown: result.total, total: props.operations.length })
            : props.labels.capabilityCount({ count: props.operations.length })
        }
      />
      <DataTable.Controls>
        <SearchBar
          action={capabilityHref({ ...route, ...closePreservingState })}
          value={props.state.search}
          placeholder={props.labels.searchApp({ app: props.app.name })}
          ariaLabel={props.labels.searchApp({ app: props.app.name })}
        />
      </DataTable.Controls>
      <DataTable
        rows={result.rows}
        columns={columns(props.labels)}
        getRowId={(row) => `${row.kind}:${row.localId}`}
        selectedRowId={selectedRowId}
        sort={{ key: props.state.sort, direction: props.state.direction }}
        sortHref={(next) =>
          capabilityHref({
            ...route,
            search: props.state.search || undefined,
            sort: next.key as CapabilitySortKey,
            direction: next.direction,
          })
        }
        ariaLabel={`${props.app.name} capabilities`}
        class="min-h-0 flex-1"
        density="compact"
        hoverRows
        empty={props.state.search ? props.labels.noMatch : props.labels.noPublished}
        renderCell={({ row, col }) => {
          const href = capabilityRowHref(props.app.id, row, effectiveState);
          if (col.id === "kind") {
            return <StatusBadge tone="neutral" label={row.kind === "query" ? props.labels.query : props.labels.action} />;
          }
          if (col.id === "title") {
            return (
              <a href={href} class="group block min-w-0" title={row.description}>
                <span class="block truncate font-medium text-primary transition-colors group-hover:app-accent-text">{row.title}</span>
                <span class="block truncate text-xs text-dimmed">{row.description}</span>
              </a>
            );
          }
          if (col.id === "id") return <code class="text-xs text-dimmed">{row.id}</code>;
          if (col.id === "policy") {
            return (
              <StatusBadge
                tone={row.policy === "Destructive" ? "warning" : "neutral"}
                label={row.policy === "Destructive" ? props.labels.destructive : row.policy === "Write" ? props.labels.write : props.labels.readOnly}
              />
            );
          }
          if (col.id === "open") {
            return (
              <IconButtonLink href={href} size="sm" label={props.labels.openCapability({ title: row.title })}>
                <i class="ti ti-chevron-right" aria-hidden="true" />
              </IconButtonLink>
            );
          }
          return null;
        }}
      />
      <Show when={result.totalPages > 1}>
        <DataTable.Footer>
          <Pagination
            currentPage={result.page}
            totalPages={result.totalPages}
            baseUrl={capabilityPaginationBaseHref({
              ...route,
              ...closePreservingState,
            })}
          />
        </DataTable.Footer>
      </Show>
    </DataTable.Panel>
  );
}

export default ssr<AuthContext>(async (c) => {
  const { t } = capabilityUiMessages.resolve([getLocale(c)]);
  const appId = c.req.param("appId");
  if (!appId) return c.notFound();

  const workspace = await loadCapabilityWorkspace(appId);
  const loaded = workspace.selected;
  if (loaded.kind === "not-found") return c.notFound();

  const kind = c.req.param("kind") as CapabilityKind | undefined;
  const capabilityId = c.req.param("capabilityId");
  if ((kind && !capabilityId) || (!kind && capabilityId)) return c.notFound();
  if (kind && kind !== "query" && kind !== "action") return c.notFound();

  const tableState = parseCapabilityTableState(new URL(c.req.url));
  const operations =
    loaded.kind === "ready" ? capabilityOperationRows(loaded.app.id, loaded.manifest.queries, loaded.manifest.actions) : [];
  const selection = loaded.kind === "ready" && kind && capabilityId ? selectCapability(loaded, kind, capabilityId) : undefined;
  if (kind && capabilityId && !selection) return c.notFound();

  const searchEntries = capabilitySearchEntries(workspace.apps, loaded.app.id, operations);
  const pageTitle = selection?.operation.title ?? loaded.app.name;
  c.get("page").title = pageTitle;

  return () => (
    <Layout
      c={c}
      fullWidth
      fullPage
      title={[
        { title: t.capabilities, href: capabilityHref({}) },
        ...(selection
          ? [
              { title: loaded.app.name, href: capabilityHref({ appId: loaded.app.id, ...stateParams(tableState) }) },
              { title: selection.operation.title },
            ]
          : [{ title: loaded.app.name }]),
      ]}
    >
      <div class="k2b-ui min-h-0 min-w-0 flex-1 overflow-hidden" style={{ background: "transparent" }}>
        <AppWorkspace>
          <CapabilitiesSidebar apps={workspace.apps} selectedAppId={loaded.app.id} searchEntries={searchEntries} labels={t} />

          <AppWorkspace.Content>
            <AppWorkspace.Main class="p-[var(--ui-space-shell)]" scroll={false}>
              <Show
                when={loaded.kind === "ready" ? loaded : undefined}
                fallback={
                  <Placeholder
                    state="error"
                    variant="panel"
                    title={t.manifestUnavailable}
                    description={t.manifestUnavailableDescription}
                    icon="ti ti-plug-connected-x"
                  />
                }
              >
                {(ready) => <CapabilityTable app={ready().app} operations={operations} state={tableState} selection={selection} labels={t} />}
              </Show>
            </AppWorkspace.Main>

            <AppWorkspace.Detail id="capability-detail-panel" open={Boolean(selection)} width="xl">
              <Show when={selection}>
                {(selected) => (
                  <CapabilitiesWorkspace
                    selection={selected()}
                    closeHref={capabilityHref({ appId: loaded.app.id, ...stateParams(tableState), page: tableState.page })}
                    initialAttemptKey={crypto.randomUUID()}
                  />
                )}
              </Show>
            </AppWorkspace.Detail>
          </AppWorkspace.Content>
        </AppWorkspace>
      </div>
    </Layout>
  );
});
