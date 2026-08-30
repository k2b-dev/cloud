import { INACTIVE_ITEM_DAYS, type SpaceItem } from "@/contracts";

const INACTIVE_ITEM_MS = INACTIVE_ITEM_DAYS * 24 * 60 * 60 * 1000;

export const itemLastActivityAt = (item: SpaceItem) => item.lastActivityAt ?? item.updatedAt;

export const isInactiveTask = (item: SpaceItem, now = Date.now()) =>
  !item.completedAt && !item.startsAt && !item.endsAt && now - new Date(itemLastActivityAt(item)).getTime() >= INACTIVE_ITEM_MS;
