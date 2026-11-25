import type { DateContext } from "@k2b/stdlib";
import { List, Section } from "@k2b/ui/v2";
import { createComputed, createMemo, For, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { ItemGroupBy, SpaceColumn, SpaceItem, SpaceTag } from "@/contracts";
import { createRetryToasts } from "../../../lib/feedback";
import { useSpaceMessages } from "../../messages";
import { keepHeld, type LeavingItems } from "../shared/leaving";
import ItemRow from "./ItemRow";
import { groupItems } from "./item-list-groups";

type ItemListProps = {
  items: SpaceItem[];
  groupCounts?: Record<string, number>;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  spaceId: string;
  selectedItemId?: string;
  groupBy: ItemGroupBy;
  baseUrl: string;
  dateConfig?: DateContext;
  canWrite: boolean;
  currentUserId: string;
  /** Rows the list keeps for a moment after its filters dropped them, such as a task just ticked off. */
  leaving: LeavingItems<SpaceItem>;
  /** The element that holds the rows, for the focus of a row that leaves. */
  host: () => HTMLElement | undefined;
};

/** Group icons are stored as v1 classes ("ti-alert-triangle"); v2 names the Tabler icon alone. */
const iconName = (icon: string | undefined) => icon?.replace(/^ti\s+/, "").replace(/^ti-/, "");

/**
 * The items of a Space as rows, one section per group (day, status, priority or tag) with its count from the server,
 * or one list without groups. A row keeps its element while its item stays, so a refresh leaves focus and a running
 * tick alone, and rows the filters just dropped stay a moment where they were.
 */
export default function ItemList(props: ItemListProps) {
  const t = useSpaceMessages();
  // The rows render again with every refresh; their Retry toasts belong to the list, so a refresh cannot close them.
  const retryToast = createRetryToasts();
  const isListed = (itemId: string) => props.items.some((item) => item.id === itemId);
  const [rows, setRows] = createStore<SpaceItem[]>([]);
  createComputed(() => {
    const next = props.items;
    const held = props.leaving.held();
    untrack(() => setRows(reconcile(keepHeld(rows, next, held))));
  });
  const grouped = createMemo(() => groupItems(rows, props.groupBy, props.columns, props.tags, props.dateConfig));
  const groups = createMemo(() => grouped().groups.filter((group) => (grouped().itemsByGroup[group.key] ?? []).length > 0));

  const Rows = (rowsProps: { items: SpaceItem[] }) => (
    <For each={rowsProps.items}>
      {(item) => (
        <ItemRow
          item={item}
          spaceId={props.spaceId}
          columns={props.columns}
          isSelected={item.id === props.selectedItemId}
          baseUrl={props.baseUrl}
          dateConfig={props.dateConfig}
          canWrite={props.canWrite}
          currentUserId={props.currentUserId}
          agenda={props.groupBy === "deadline"}
          isListed={isListed}
          leaving={props.leaving}
          list={props.host}
          retryToast={retryToast}
        />
      )}
    </For>
  );

  return (
    // k2b-ui gap: v2 has no virtualized list yet; a page holds at most 50 rows (the list pages on the server).
    <>
      {props.groupBy === "none" ? (
        <List label={t.list}>
          <Rows items={rows} />
        </List>
      ) : (
        <For each={groups()}>
          {(group) => (
            <Section
              icon={iconName(group.icon) ?? "point"}
              color={group.color}
              title={group.meta ? `${group.label} · ${group.meta}` : group.label}
              count={props.groupCounts?.[group.key] ?? (grouped().itemsByGroup[group.key] ?? []).length}
            >
              <Rows items={grouped().itemsByGroup[group.key] ?? []} />
            </Section>
          )}
        </For>
      )}
    </>
  );
}
