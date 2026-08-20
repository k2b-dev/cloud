import type { DateContext } from "@k2b/stdlib";
import { dialogCore, panelDialogOptions } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { SpaceColumn, SpaceItem, SpaceTag } from "@/contracts";
import ItemForm, { type ItemFormData } from "./ItemForm";

type EditItemParams = {
  spaceId: string;
  item: SpaceItem;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  dateConfig?: DateContext;
};

export const saveItemFormData = async (params: { spaceId: string; itemId: string; data: ItemFormData }): Promise<void> => {
  const res = await apiClient[":id"].items[":itemId"].$patch({
    param: { id: params.spaceId, itemId: params.itemId },
    json: {
      ...params.data,
      description: params.data.description ?? null,
      location: params.data.location ?? null,
      url: params.data.url ?? null,
      priority: params.data.priority ?? null,
      deadline: params.data.deadline ?? null,
      estimatedDurationMinutes: params.data.estimatedDurationMinutes ?? null,
      startsAt: params.data.startsAt ?? null,
      endsAt: params.data.endsAt ?? null,
    },
  });
  if (!res.ok) throw new Error("Could not update item");
};

export const openEditItemDialog = async (params: EditItemParams): Promise<ItemFormData | null> =>
  (await dialogCore.open<ItemFormData | null>(
    (close) => (
      <ItemForm
        spaceId={params.spaceId}
        item={params.item}
        columns={params.columns}
        tags={params.tags}
        onSubmit={(data) => close(data)}
        onCancel={() => close(null)}
        submitLabel="Save Item"
        title="Edit item"
        icon="ti ti-edit"
        dateConfig={params.dateConfig}
      />
    ),
    panelDialogOptions,
  )) ?? null;
