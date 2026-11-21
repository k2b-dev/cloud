import type { DateContext } from "@k2b/stdlib";
import { RowGroup } from "@k2b/ui";
import { createComputed, createMemo, For, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { ItemGroupBy, SpaceColumn, SpaceItem, SpaceTag } from "@/contracts";
import { createRetryToasts } from "../../../lib/feedback";
import { useSpaceMessages } from "../../messages";
import { keepHeld, type LeavingItems } from "../shared/leaving";
import ItemRow from "./ItemRow";
import { groupItems, type ItemListGroup } from "./item-list-groups";

type ItemListProps = {
  items: SpaceItem[];
  groupCounts?: Record<string, number>;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  spaceId: string;
  selectedItemId?: string;
  groupBy: ItemGroupBy;
  showCompleted?: boolean;
  baseUrl: string;
  dateConfig?: DateContext;
  canWrite: boolean;
  currentUserId: string;
  /** Rows the list keeps for a moment after its filters dropped them, such as a task just ticked off. */
  leaving: LeavingItems<SpaceItem>;
};

// =============================================================================
// Group Header Component
// =============================================================================

/** A group's name with its sign: an icon or the status dot, and a date where the group is a day. */
function GroupTitle(props: { config: ItemListGroup }) {
  return (
    <span class="spaces-list-group">
      <span class="spaces-list-group__sign" aria-hidden="true">
        {props.config.icon ? (
          <i class={`ti ${props.config.icon}`} style={props.config.color?.startsWith("#") ? `color: ${props.config.color}` : undefined} />
        ) : (
          <span class="spaces-list-row__dot" style={`background-color: ${props.config.color ?? "#6b7280"}`} />
        )}
      </span>
      {props.config.label}
      {props.config.meta && <span class="spaces-list-group__meta">{props.config.meta}</span>}
    </span>
  );
}

/** The column head of the list: the same grid as its rows, sticky in the list's one scroll area. */
function ColumnHead() {
  const t = useSpaceMessages();
  return (
    <div class="spaces-list-head" aria-hidden="true">
      <span class="spaces-list-head__title">{t.title}</span>
      <span class="spaces-list-head__priority">{t.priority}</span>
      <span class="spaces-list-head__date">{t.schedule}</span>
      <span class="spaces-list-head__tags">{t.tags}</span>
      <span class="spaces-list-head__people">{t.assignees}</span>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * Unified item list with configurable grouping.
 * Renders items grouped by column, priority, tag, deadline, or flat.
 */
export default function ItemList(props: ItemListProps) {
  // The rows render again with every refresh; their Retry toasts belong to the list, so a refresh cannot close them.
  const retryToast = createRetryToasts();
  const isListed = (itemId: string) => props.items.some((item) => item.id === itemId);
  // A row keeps its element while its item stays in the list, so a refresh leaves focus, a running check animation,
  // and a collapsing row alone. Rows the list just dropped stay a moment where they were.
  const [rows, setRows] = createStore<SpaceItem[]>([]);
  createComputed(() => {
    const next = props.items;
    const held = props.leaving.held();
    untrack(() => setRows(reconcile(keepHeld(rows, next, held))));
  });
  const grouped = createMemo(() => groupItems(rows, props.groupBy, props.columns, props.tags, props.dateConfig));
  const nonEmptyGroups = createMemo(() => {
    const current = grouped();
    return current.groups.filter((group) => (current.itemsByGroup[group.key] || []).length > 0);
  });
  /** Keys of the shown groups: a group keeps its section while it has rows, also rows that are leaving. */
  const groupKeys = createMemo(() => nonEmptyGroups().map((group) => group.key));
  let list: HTMLDivElement | undefined;

  const Rows = (rowsProps: { items: SpaceItem[] }) => (
    <For each={rowsProps.items}>
      {(item) => (
        <ItemRow
          item={item}
          spaceId={props.spaceId}
          columns={props.columns}
          tags={props.tags}
          isSelected={item.id === props.selectedItemId}
          baseUrl={props.baseUrl}
          dateConfig={props.dateConfig}
          canWrite={props.canWrite}
          currentUserId={props.currentUserId}
          agenda={props.groupBy === "deadline"}
          showStatus={props.groupBy !== "column"}
          isListed={isListed}
          leaving={props.leaving}
          list={() => list}
          retryToast={retryToast}
        />
      )}
    </For>
  );

  return (
    // Moving the pointer over the list, maybe towards the next task, keeps the rows that left in place a while longer.
    <div ref={list} class="spaces-list" on:pointermove={(event) => event.pointerType === "mouse" && props.leaving.postpone()}>
      <ColumnHead />
      {props.groupBy === "none" ? (
        <div class="spaces-list__rows k2b-divided">
          <Rows items={rows} />
        </div>
      ) : (
        <div class="spaces-list__groups k2b-divided">
          <For each={groupKeys()}>
            {(key) => {
              const group = () => nonEmptyGroups().find((candidate) => candidate.key === key);
              const items = () => grouped().itemsByGroup[key] ?? [];
              // A group whose last rows collapse collapses with them, header and gap included, so the groups after it
              // slide up instead of jumping once the rows have gone.
              const collapsing = () => items().length > 0 && items().every((item) => props.leaving.collapsing(item.id));
              return (
                <div
                  class={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
                    collapsing() ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]"
                  }`}
                >
                  <div class={`min-h-0 ${collapsing() ? "overflow-hidden" : ""}`}>
                    <RowGroup
                      level={3}
                      title={<GroupTitle config={group() ?? { key, label: "" }} />}
                      count={props.groupCounts?.[key] ?? items().length}
                    >
                      <Rows items={items()} />
                    </RowGroup>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      )}
    </div>
  );
}
