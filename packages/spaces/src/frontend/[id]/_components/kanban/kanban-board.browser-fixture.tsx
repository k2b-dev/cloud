import { LocaleProvider } from "@k2b/ui";
import { Nav, Pane, Workspace } from "@k2b/ui/v2";
import type { ItemListResult, SpaceColumn, SpaceTag, SpaceWormhole } from "@/contracts";
import { defaultFilter, parseFilterFromUrl } from "../filter/types";
import BoardPane from "../workspace/BoardPane";
import ItemsPane from "../workspace/ItemsPane";
import type { KanbanBucketInitial } from "./types";

type Props = {
  spaceId: string;
  baseUrl: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  wormholes: SpaceWormhole[];
  initialBuckets: KanbanBucketInitial[];
  foldedColumns: string[];
  selectedItemId: string;
  canWrite: boolean;
  currentUserId: string;
  locale: string;
  workspace?: "kanban" | "table";
  itemsResult?: ItemListResult;
};

/** The board (or the table) as the Space page mounts it on v2: one Workspace below the server locale. */
export default function KanbanFixture(props: Props) {
  const space = {
    id: props.spaceId,
    name: "Project",
    description: null,
    color: "#3b82f6",
    icalToken: null,
    columns: props.columns,
    tags: props.tags,
    templates: [],
    virtualColumns: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const filter = parseFilterFromUrl(new URL(props.baseUrl, "http://spaces.local"));
  return (
    <LocaleProvider locale={props.locale}>
      <Workspace
        sidebar={
          props.workspace ? (
            <Nav
              title="Spaces"
              icon="layout-kanban"
              groups={[{ items: [{ label: "Project", icon: "point-filled", href: "/app/spaces/Space1", current: true }] }]}
            />
          ) : undefined
        }
        detail={props.workspace ? true : undefined}
        detailEmpty={props.workspace ? { icon: "click", text: "Selected item" } : undefined}
      >
        <Pane.Split>
          {props.workspace === "table" && props.itemsResult ? (
            <ItemsPane
              space={space}
              currentView="table"
              filter={defaultFilter}
              initialItemsResult={props.itemsResult}
              itemLinkBaseUrl={props.baseUrl}
              selectedItemId=""
              canWrite={props.canWrite}
              currentUserId={props.currentUserId}
            />
          ) : (
            <BoardPane
              space={space}
              filter={filter}
              baseUrl={props.baseUrl}
              wormholes={props.wormholes}
              initialBuckets={props.initialBuckets}
              foldedColumns={props.foldedColumns}
              selectedItemId={props.selectedItemId}
              canWrite={props.canWrite}
              currentUserId={props.currentUserId}
            />
          )}
        </Pane.Split>
      </Workspace>
    </LocaleProvider>
  );
}
