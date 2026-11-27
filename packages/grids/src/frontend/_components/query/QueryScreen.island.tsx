import { navigationState } from "../workspace/navigation-catalog";
import type { PublicOkWorkspaceState } from "../workspace/workspace-public-state-model";
import QueryScreen from "./QueryScreen";
import QueryViewScreen from "./QueryViewScreen";

/** The query of a base and the views that group or aggregate, on v2: the query routes of the base page. */
export default function QueryScreenIsland(props: { state: PublicOkWorkspaceState }) {
  const state = props.state;
  const route = state.route;
  if (route.kind === "query")
    return (
      <QueryScreen
        frame={navigationState(state)}
        revision={state.workspaceRevision}
        baseId={state.base.id}
        baseName={state.base.name}
        initialQuery={route.initialQuery}
        initialCursor={route.initialCursor}
        initialPreview={route.initialPreview}
        queryPath={route.queryPath}
        currentSource={route.currentSource}
        tables={state.catalog.tables}
        fieldsByTable={state.catalog.fieldsByTable}
        viewsByTable={state.catalog.viewsByTable}
      />
    );
  if (route.kind !== "queryResultView") return null;
  // a view this person reaches by its link may stand on a table the catalog does not list
  return (
    <QueryViewScreen
      frame={navigationState(state)}
      revision={state.workspaceRevision}
      baseId={state.base.id}
      table={route.activeTable}
      view={route.activeView}
      views={state.catalog.viewsByTable[route.activeTable.id] ?? [route.activeView]}
      fields={route.fields}
      fieldsByTable={{ ...state.catalog.fieldsByTable, [route.activeTable.id]: route.fields }}
      canEditView={route.canEditActiveView}
      initialCursor={route.initialCursor}
      initialResult={route.initialResult}
    />
  );
}
