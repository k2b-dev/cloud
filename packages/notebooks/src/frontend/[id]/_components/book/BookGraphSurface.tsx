import { AppWorkspace } from "@k2b/ui";
import type { NoteGraph } from "../../../../service/links";
import NotebookGraph from "../graph/NotebookGraph.island";
import type { GraphViewState } from "../graph/view-state";
import WorkspaceEventBridge from "../sidebar/WorkspaceEventBridge.island";
import BookGraphLive from "./BookGraphLive.island";
import BookNavigator, { type BookNavigatorProps } from "./BookNavigator.island";

type Props = BookNavigatorProps & {
  graph: NoteGraph;
  graphView: GraphViewState;
  now: string;
  timeZone: string;
  appUrl: string;
  cursor: string | null;
  backHref?: string;
};

/** The graph inside the Book shell, for readers and for people who open it from Book. */
export default function BookGraphSurface(props: Props) {
  return (
    <div class="notebook-book-shell">
      <AppWorkspace mobileSurface="flush" class="notebook-book-workspace">
        <BookNavigator
          userId={props.userId}
          notebookId={props.notebookId}
          notebookName={props.notebookName}
          notebookIcon={props.notebookIcon}
          selectedNoteId={props.selectedNoteId}
          navigation={props.navigation}
          tags={props.tags}
          currentHref={props.currentHref}
          canWrite={props.canWrite}
          locked={props.locked}
          navigationHidden={props.navigationHidden}
          current="graph"
          graphBack={props.graphBack}
        />
        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={false} class="relative">
            {/* Like Book and the workspace, the page follows live changes, and a revoked grant or an ended session reloads it. */}
            <WorkspaceEventBridge notebookId={props.notebookId} appUrl={props.appUrl} initialCursor={props.cursor} />
            <BookGraphLive notebookId={props.notebookId} bookHref={props.currentHref} />
            <NotebookGraph
              notebookId={props.notebookId}
              notebookName={props.notebookName}
              selectedNoteId={props.selectedNoteId}
              graph={props.graph}
              from="book"
              backHref={props.backHref}
              view={props.graphView}
              now={props.now}
              timeZone={props.timeZone}
              navigationHidden={props.navigationHidden}
            />
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </div>
  );
}
