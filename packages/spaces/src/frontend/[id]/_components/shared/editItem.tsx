import type { DateContext } from "@k2b/stdlib";
import { dialogCore, panelDialogOptions } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { SpaceColumn, SpaceItem, SpaceTag } from "@/contracts";
import { readResponseError } from "../../../lib/response";
import { spaceMessages } from "../../messages";
import ItemForm, { type ItemFormData } from "./ItemForm";

type EditItemParams = {
  spaceId: string;
  item: SpaceItem;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  dateConfig?: DateContext;
};

/** Creates one item in the given Space; a refusal throws the server's reason, or `failure` when it gives none. */
export const createSpaceItem = async (spaceId: string, data: ItemFormData, failure: string): Promise<SpaceItem> => {
  const res = await apiClient[":id"].items.$post({
    param: { id: spaceId },
    json: {
      ...data,
      location: data.location ?? undefined,
      url: data.url ?? undefined,
      priority: data.priority ?? undefined,
      recurrence: data.recurrence ?? undefined,
      estimatedDurationMinutes: data.estimatedDurationMinutes ?? undefined,
    },
  });
  if (!res.ok) throw new Error(await readResponseError(res, failure));
  return res.json();
};

export const saveItemFormData = async (params: { spaceId: string; itemId: string; data: ItemFormData; locale?: string }): Promise<void> => {
  const { t } = spaceMessages.resolve(params.locale ? [params.locale] : []);
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
  if (!res.ok) throw new Error(await readResponseError(res, t.itemUpdateFailed));
};

/**
 * Opens the edit dialog and saves from it. The dialog stays open until the save answers, so a failure shows in it with
 * the input still there; it resolves with the saved values, or `null` when the user cancels.
 */
export const openEditItemDialog = async (params: EditItemParams): Promise<ItemFormData | null> => {
  const locale = params.dateConfig?.locale;
  const { t } = spaceMessages.resolve(locale ? [locale] : []);
  return (
    (await dialogCore.open<ItemFormData | null>(
      (close) => (
        <ItemForm
          spaceId={params.spaceId}
          item={params.item}
          columns={params.columns}
          tags={params.tags}
          onSubmit={async (data) => {
            await saveItemFormData({ spaceId: params.spaceId, itemId: params.item.id, data, locale });
            close(data);
          }}
          onCancel={() => close(null)}
          submitLabel={t.saveItem}
          title={t.editItem}
          icon="ti ti-edit"
          dateConfig={params.dateConfig}
        />
      ),
      panelDialogOptions,
    )) ?? null
  );
};
