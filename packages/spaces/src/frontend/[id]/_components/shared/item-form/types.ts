import type { DateContext } from "@k2b/stdlib";
import type { Recurrence, SpaceColumn, SpaceItem, SpaceItemResourceReferenceInput, SpaceItemTemplate, SpaceTag } from "@/contracts";

export type Priority = "low" | "medium" | "high" | "urgent";
export type ItemType = "task" | "event";

export type ItemFormData = {
  references?: SpaceItemResourceReferenceInput[];
  columnId: string;
  title: string;
  description?: string;
  location?: string | null;
  url?: string | null;
  startsAt?: string;
  endsAt?: string;
  allDay?: boolean;
  recurrence?: Recurrence | null;
  deadline?: string;
  estimatedDurationMinutes?: number | null;
  priority?: Priority | null;
  assigneeIds?: string[];
  tagIds?: string[];
  /** Create only: checklist entries the new task starts with. */
  checklist?: string[];
  /** Create only: also assign the person who creates the item. */
  assignCreator?: boolean;
};

export type ItemFormProps = {
  spaceId: string;
  item?: SpaceItem;
  quickCreate?: boolean;
  defaults?: Partial<ItemFormData> & { type?: ItemType };
  columns: SpaceColumn[];
  tags?: SpaceTag[];
  /** Create only: templates of the Space; the dialog offers those of the chosen kind. */
  templates?: SpaceItemTemplate[];
  /** May return a promise: the form then stays busy until it settles and shows a rejection as its error. */
  onSubmit: (data: ItemFormData) => void | Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
  title?: string;
  icon?: string;
  dateConfig?: DateContext;
};
