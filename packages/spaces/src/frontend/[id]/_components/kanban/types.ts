import type { SpaceItem } from "@/contracts";

export type KanbanBucketInitial = {
  key: string;
  label: string;
  color: string | null;
  kind: "column";
  columnId: string | null;
  isDone: boolean;
  items: SpaceItem[];
  page: number;
  totalPages: number;
  total: number;
  /** Present only while a board filter is active: the column's size without it. */
  unfilteredTotal?: number;
};
