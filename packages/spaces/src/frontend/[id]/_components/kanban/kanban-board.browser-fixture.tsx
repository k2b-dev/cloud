import { LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
import SpacesKanbanRoute from "../workspace/SpacesKanbanRoute.island";

type Props = ComponentProps<typeof SpacesKanbanRoute> & { locale: string };

/** The Kanban route as the workspace page mounts it: an island below the server locale. */
export default function KanbanFixture(props: Props) {
  return (
    <LocaleProvider locale={props.locale}>
      <SpacesKanbanRoute
        spaceId={props.spaceId}
        baseUrl={props.baseUrl}
        columns={props.columns}
        tags={props.tags}
        wormholes={props.wormholes}
        initialBuckets={props.initialBuckets}
        foldedColumns={props.foldedColumns}
        selectedItemId={props.selectedItemId}
        canWrite={props.canWrite}
        currentUserId={props.currentUserId}
      />
    </LocaleProvider>
  );
}
