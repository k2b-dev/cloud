import type { ACL } from "@k2b/filegate";
import type { DestinationAccess } from "../contracts";

/** Describes the folder ACL, including its effective mask; it does not guess a finite member list. */
export function destinationAccess(acl: ACL, groupName: string | null): DestinationAccess {
  const mask = acl.entries.find((entry) => entry.tag === "mask")?.permissions ?? "rwx";
  const reads = (permissions: string, masked: boolean) =>
    permissions[0] === "r" && permissions[2] === "x" && (!masked || (mask[0] === "r" && mask[2] === "x"));
  const allowed = acl.entries.filter((entry) => reads(entry.permissions, entry.tag !== "owner" && entry.tag !== "other"));
  return {
    kind: "filesystem",
    name: groupName,
    owner: allowed.some((entry) => entry.tag === "owner"),
    group: allowed.some((entry) => entry.tag === "owningGroup"),
    additionalUsers: allowed.filter((entry) => entry.tag === "user").length,
    additionalGroups: allowed.filter((entry) => entry.tag === "group").length,
    others: allowed.some((entry) => entry.tag === "other"),
  };
}
