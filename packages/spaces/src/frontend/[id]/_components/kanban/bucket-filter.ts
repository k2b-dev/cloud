import type { ItemFilter, SpaceVirtualColumnKind } from "@/contracts";
import type { FilterState } from "../filter/types";
import type { KanbanBucketInitial } from "./types";

const nonEmpty = <T>(values: T[]) => (values.length > 0 ? values : undefined);

/**
 * One board column's page. The board filter only narrows what the URL asks for; the column decides
 * which tasks it holds. A task that an enabled automatic column gathers shows only there: open tasks
 * with unfinished blockers in Blocked, else open tasks past their deadline in Overdue. Done columns
 * keep all their items.
 */
export const kanbanBucketFilter = (params: {
  bucket: Pick<KanbanBucketInitial, "kind" | "columnId" | "isDone">;
  /** The automatic columns the board shows. */
  virtualKinds: ReadonlySet<SpaceVirtualColumnKind>;
  filter: FilterState;
  page: number;
  pageSize: number;
}): ItemFilter => {
  const { bucket, virtualKinds, filter } = params;
  const open = !bucket.isDone;
  const gathered =
    bucket.kind === "blocked"
      ? { blocked: true }
      : bucket.kind === "overdue"
        ? { overdue: true, ...(virtualKinds.has("blocked") ? { blocked: false } : {}) }
        : open
          ? {
              ...(virtualKinds.has("blocked") ? { blocked: false } : {}),
              ...(virtualKinds.has("overdue") ? { overdue: false } : {}),
            }
          : {};
  return {
    ...gathered,
    type: "all",
    status: open ? "active" : "completed",
    activity: filter.activity,
    priority: nonEmpty(filter.priority),
    tagIds: nonEmpty(filter.tagIds),
    columnIds: bucket.kind === "column" && bucket.columnId ? [bucket.columnId] : undefined,
    assignedTo: filter.assignedTo,
    deadlineFilter: filter.deadlineFilter,
    search: filter.search || undefined,
    sort: "column",
    sortDesc: false,
    groupBy: "column",
    page: params.page,
    pageSize: params.pageSize,
  };
};

/** The automatic columns a board's buckets include. */
export const boardVirtualKinds = (buckets: readonly Pick<KanbanBucketInitial, "kind">[]) =>
  new Set(buckets.flatMap((bucket) => (bucket.kind === "column" ? [] : [bucket.kind])));
