import { AppWorkspace } from "@k2b/ui";
import type { NoteGraph } from "../../../../service/links";
import NotebookGraph from "../graph/NotebookGraph.island";
import BookNavigator, { type BookNavigatorProps } from "./BookNavigator.island";

export default function BookGraphSurface(props: BookNavigatorProps & { graph: NoteGraph }) {
  return (
    <div class="notebook-book-shell">
      <AppWorkspace mobileSurface="flush" class="notebook-book-workspace">
        <BookNavigator
          userId={props.userId}
          notebookId={props.notebookId}
          notebookName={props.notebookName}
          notebookIcon={props.notebookIcon}
          selectedNoteId={props.selectedNoteId}
          tree={props.tree}
          tags={props.tags}
          currentHref={props.currentHref}
          canWrite={props.canWrite}
          locked={props.locked}
          navigationHidden={props.navigationHidden}
          current="graph"
        />
        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={false}>
            <NotebookGraph notebookId={props.notebookId} selectedNoteId={props.selectedNoteId} graph={props.graph} from="book" />
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </div>
  );
}
