import type { DateContext } from "@k2b/stdlib";
import { createMemo } from "solid-js";
import type { ItemGroupBy, SpaceColumn, SpaceItem, SpaceTag } from "@/contracts";
import { createRetryToasts } from "../../../lib/feedback";
import ItemRow from "./ItemRow";
import { groupItems, type ItemListGroup } from "./item-list-groups";

type ItemListProps = {
  items: SpaceItem[];
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
};

// =============================================================================
// Group Header Component
// =============================================================================

function GroupHeader(props: { config: ItemListGroup; count: number; id: string }) {
  // Flat list has no header
  if (!props.config.label) return null;

  return (
    <div class="flex min-h-9 items-center gap-2 px-2.5 py-2">
      {/* Icon or color dot */}
      {props.config.icon && !props.config.color?.startsWith("#") && <i class={`ti ${props.config.icon} text-sm text-dimmed`} />}
      {props.config.color && !props.config.icon && (
        <div class="h-2.5 w-2.5 shrink-0 rounded-full" style={`background-color: ${props.config.color}`} />
      )}
      {props.config.icon && props.config.color && <i class={`ti ${props.config.icon} text-sm`} style={`color: ${props.config.color}`} />}

      <h2 id={props.id} class="text-sm font-medium text-primary">
        {props.config.label}
      </h2>
      {props.config.meta && <span class="text-xs text-dimmed">{props.config.meta}</span>}
      <span class="ml-auto text-xs tabular-nums text-dimmed">{props.count}</span>
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
  const grouped = createMemo(() => groupItems(props.items, props.groupBy, props.columns, props.tags, props.dateConfig));
  const nonEmptyGroups = createMemo(() => {
    const current = grouped();
    return current.groups.filter((group) => (current.itemsByGroup[group.key] || []).length > 0);
  });

  return (
    <div class="min-w-0">
      {props.groupBy === "none" ? (
        <div class="flex flex-col rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-1.5">
          {props.items.map((item) => (
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
              isListed={isListed}
              retryToast={retryToast}
            />
          ))}
        </div>
      ) : (
        <div class="flex flex-col gap-[var(--ui-space-section)]">
          {nonEmptyGroups().map((group) => {
            const items = grouped().itemsByGroup[group.key] ?? [];
            const headingId = `space-list-group-${group.key}`;
            return (
              <section aria-labelledby={headingId} class="rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-1.5">
                <GroupHeader config={group} count={items.length} id={headingId} />
                <div class="flex flex-col">
                  {items.map((item) => (
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
                      isListed={isListed}
                      retryToast={retryToast}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
