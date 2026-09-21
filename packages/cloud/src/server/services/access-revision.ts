import { createHash } from "node:crypto";
import type { PermissionLevel, Principal } from "./access";

/** Compare the grants that were reviewed with those held under a resource lock. */
export function accessRevision(entries: ReadonlyArray<{ id: string; principal: Principal; permission: PermissionLevel }>): string {
  const state = entries
    .map((entry) => [entry.id, entry.permission, Object.entries(entry.principal).sort(([left], [right]) => left.localeCompare(right))])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
