import { navigationState } from "../workspace/navigation-catalog";
import type { PublicOkWorkspaceState } from "../workspace/workspace-public-state-model";
import DocumentsScreen from "./DocumentsScreen";

/** "All documents" of a base on v2: the documents route of the base page, with the base's frame. */
export default function DocumentsScreenIsland(props: { state: PublicOkWorkspaceState }) {
  const route = props.state.route;
  if (route.kind !== "documents") return null;
  return (
    <DocumentsScreen
      frame={navigationState(props.state)}
      revision={props.state.workspaceRevision}
      baseId={props.state.base.id}
      canWriteDocuments={route.canWriteDocuments}
      documentTemplateLevels={props.state.catalog.documentTemplateLevels}
      linkableWorkflowIds={props.state.catalog.workflows.map((workflow) => workflow.id)}
      initialCatalog={route.initialCatalog}
      facets={route.facets}
      initialBrowserPage={route.initialBrowserPage}
      dateConfig={props.state.dateConfig}
    />
  );
}
