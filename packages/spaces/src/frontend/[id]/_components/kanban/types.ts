import type { SpaceItem, SpaceVirtualColumnKind } from "@/contracts";

export type KanbanBucketInitial = {
  key: string;
  label: string;
  color: string | null;
  /** A status column, or an automatic column that gathers open tasks across statuses and takes no drops. */
  kind: "column" | SpaceVirtualColumnKind;
  columnId: string | null;
  isDone: boolean;
  items: SpaceItem[];
  page: number;
  totalPages: number;
  total: number;
  /** Present only while a board filter is active: the column's size without it. */
  unfilteredTotal?: number;
};
