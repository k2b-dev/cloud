import { navigationState } from "../workspace/navigation-catalog";
import type { PublicOkWorkspaceState } from "../workspace/workspace-public-state-model";
import DocumentTemplateScreen from "./DocumentTemplateScreen";

/** The documents of one template on v2: the document template route of the base page, with the base's frame. */
export default function DocumentTemplateScreenIsland(props: { state: PublicOkWorkspaceState }) {
  const route = props.state.route;
  if (route.kind !== "documentTemplate") return null;
  return (
    <DocumentTemplateScreen
      frame={navigationState(props.state)}
      revision={props.state.workspaceRevision}
      baseId={props.state.base.id}
      table={route.table}
      template={route.template}
      editableTemplate={route.canManageTemplate ? route.editableTemplate : null}
      canWriteTemplate={route.canWriteTemplate}
      initialRecordId={route.initialRecordId}
      initialState={{ mode: route.initialDocumentViewMode, q: route.initialSearch, path: route.initialPath }}
      initialBrowserPage={route.initialBrowserPage}
      dateConfig={props.state.dateConfig}
    />
  );
}
