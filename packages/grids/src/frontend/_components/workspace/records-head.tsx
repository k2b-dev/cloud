import { AppWorkspace, useLocale, ViewTabs } from "@k2b/ui";
import type { JSX } from "solid-js";
import { filterSearchableFields } from "../../../searchable-fields";
import { activeDisplayConfig } from "../records-view/display-mode";
import { NEW_RECORD_PARAM } from "../records-view/records-head-bus";
import { workspaceMessages } from "./messages";
import RecordsHeadActions from "./RecordsHeadActions.island";
import type { PublicOkWorkspaceState, PublicWorkspaceRecordsRoute } from "./workspace-public-state-model";

/** What the head's main action opens: a menu when forms add records too, else the record dialog; nothing when no way is open. */
export const recordsCreatePopup = (route: PublicWorkspaceRecordsRoute): "menu" | "dialog" | null => {
  if (!route.canWriteRecords || route.initialState.query.deletedOnly === true) return null;
  const policy = route.activeTable.mutationPolicy;
  const allows = (source: "direct" | "form") => policy.mode === "all" || policy.sources.includes(source);
  const direct = allows("direct") && !route.activeTable.disableDirectInsert;
  const forms = allows("form") ? route.formsForTable.filter((form) => form.isActive).length : 0;
  if (forms > 0) return direct || forms > 1 ? "menu" : "dialog";
  return direct ? "dialog" : null;
};

/**
 * Adding is locked for a writer here, and why: no direct changes and no active form may add records. The head shows the
 * locked "Add record" with this reason; with direct changes allowed but direct insert switched off, nothing shows.
 */
export const recordsCreateLock = (route: PublicWorkspaceRecordsRoute): "activeFormRequired" | "changesUnavailable" | undefined => {
  if (!route.canWriteRecords || route.initialState.query.deletedOnly === true || route.activeView !== null) return undefined;
  const policy = route.activeTable.mutationPolicy;
  const allows = (source: "direct" | "form") => policy.mode === "all" || policy.sources.includes(source);
  if (allows("direct")) return undefined;
  if (allows("form") && route.formsForTable.some((form) => form.isActive)) return undefined;
  return allows("form") ? "activeFormRequired" : "changesUnavailable";
};

/**
 * The head of a table page (K6): the table and its saved views as tabs on the head line, the search and "⋯" at the
 * end, and the one filled main action "Add record". A record list shows nothing else above its status row.
 */
export function RecordsHead(props: { state: PublicOkWorkspaceState }): JSX.Element {
  const { t } = workspaceMessages.resolve([useLocale()()]);
  const state = props.state;
  const route = state.route;
  if (route.kind !== "records" && route.kind !== "queryResultView") return null;
  const table = route.activeTable;
  const edit = state.adminModeRequested ? "?edit=true" : "";
  const tableHref = `/app/grids/${state.base.id}/table/${table.id}`;
  const views = state.catalog.viewsByTable[table.id] ?? [];
  const tabs = (
    <ViewTabs
      label={t.views}
      current={route.activeView?.id ?? "all"}
      fit
      max={8}
      items={[
        { id: "all", label: t.allRecords, href: `${tableHref}${edit}` },
        ...views.map((view) => ({ id: view.id, label: view.name, href: `${tableHref}/view/${view.id}${edit}` })),
      ]}
    />
  );
  if (route.kind === "queryResultView") return <AppWorkspace.Head views={tabs} />;
  const popup = recordsCreatePopup(route);
  const trashMode = route.initialState.query.deletedOnly === true;
  return (
    <AppWorkspace.Head
      views={tabs}
      actions={
        <RecordsHeadActions
          baseId={state.base.id}
          tableId={table.id}
          tableName={table.name}
          tableKind={table.kind}
          searchableFields={filterSearchableFields(route.fields)}
          initialSearch={{ q: route.initialState.search.q, fieldIds: route.initialState.search.fieldIds }}
          trashMode={trashMode}
          canReadTable={route.canReadTable}
          createLock={recordsCreateLock(route)}
          initialCardSize={
            !trashMode &&
            !(route.initialState.query.groupBy ?? []).length &&
            activeDisplayConfig(route.displayConfig, route.activeView?.displayConfig).mode === "cards"
              ? route.initialState.cardSize
              : null
          }
          queryHref={route.activeView ? `${tableHref}/view/${route.activeView.id}/query` : `${tableHref}/query`}
          bulkLaunchers={route.bulkSelectionLaunchers.map((launcher) => ({
            id: launcher.id,
            name: launcher.name,
            closesSelection:
              launcher.config.kind === "bulk" && "profile" in launcher.config && launcher.config.profile === "closeSelection",
          }))}
        />
      }
      primary={
        popup
          ? {
              label: t.addRecord,
              icon: "ti ti-plus",
              href: `${route.activeView ? `${tableHref}/view/${route.activeView.id}` : tableHref}?${NEW_RECORD_PARAM}=1`,
              popup,
            }
          : undefined
      }
    />
  );
}
