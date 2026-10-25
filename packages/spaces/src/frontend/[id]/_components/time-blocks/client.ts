import { type SpaceTimeBlock, SpaceTimeBlockSchema } from "../../../../time-block-contracts";
import { readResponseError } from "../../../lib/response";

type Create = { id: string; startsAt: string; endsAt: string };
const path = (id: string) => `/api/spaces/blocks/${encodeURIComponent(id)}`;
export const readTimeBlock = async (id: string, failure: string): Promise<SpaceTimeBlock | null> => {
  const response = await fetch(path(id));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await readResponseError(response, failure));
  return SpaceTimeBlockSchema.parse(await response.json());
};
/** A lost response is reconciled before an identical request is repeated. The caller retains the UUID. */
export const createTimeBlock = async (
  spaceId: string,
  itemId: string,
  data: Create,
  failure: string,
  retry = false,
): Promise<SpaceTimeBlock> => {
  if (retry) {
    const found = await readTimeBlock(data.id, failure);
    if (found) return found;
  }
  const response = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}/time-blocks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(await readResponseError(response, failure));
  return SpaceTimeBlockSchema.parse(await response.json());
};
export const updateTimeBlock = async (
  id: string,
  data: { title?: string; startsAt?: string; endsAt?: string },
  failure: string,
): Promise<SpaceTimeBlock> => {
  const response = await fetch(path(id), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  if (!response.ok) throw new Error(await readResponseError(response, failure));
  return SpaceTimeBlockSchema.parse(await response.json());
};
export const deleteTimeBlock = async (id: string, failure: string): Promise<void> => {
  const response = await fetch(path(id), { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error(await readResponseError(response, failure));
};
