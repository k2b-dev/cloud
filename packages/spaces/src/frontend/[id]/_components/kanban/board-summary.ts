import type { DateContext } from "@k2b/stdlib";
import type { StatusRowFact } from "@k2b/ui";
import type { SpaceItem, SpaceVirtualColumnKind } from "@/contracts";
import { isTaskOverdue } from "@/task-overdue";
import type { KanbanBucketInitial } from "./types";

export type BoardSummary = { total: number; facts: StatusRowFact[] };

/**
 * The lead statement and key figures of a board (K6), only from numbers its columns already hold: open from the
 * columns' totals; overdue and blocked from their automatic columns, else from the cards when every column is loaded
 * whole. The server and the first browser frame read the same buckets, so they show the same row.
 */
export const boardSummary = (
  buckets: readonly KanbanBucketInitial[],
  labels: { open: string; overdue: string; blocked: string },
  dateConfig?: DateContext,
): BoardSummary => {
  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0);
  const open = buckets.reduce((sum, bucket) => sum + (bucket.isDone ? 0 : bucket.total), 0);
  const whole = buckets.every((bucket) => bucket.items.length >= bucket.total);
  const openCards = [...new Map(buckets.flatMap((bucket) => bucket.items).map((item) => [item.id, item])).values()].filter(
    (item) => !item.completedAt,
  );
  const count = (kind: SpaceVirtualColumnKind, test: (item: SpaceItem) => boolean) => {
    const column = buckets.find((bucket) => bucket.kind === kind);
    if (column) return column.total;
    return whole ? openCards.filter(test).length : undefined;
  };
  const overdue = count("overdue", (item) => isTaskOverdue(item, dateConfig));
  const blocked = count("blocked", (item) => item.activeBlockerCount > 0);
  return {
    total,
    facts: [
      { value: String(open), label: labels.open },
      ...(overdue ? [{ value: String(overdue), label: labels.overdue }] : []),
      ...(blocked ? [{ value: String(blocked), label: labels.blocked }] : []),
    ],
  };
};
