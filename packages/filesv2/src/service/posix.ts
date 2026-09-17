import type { ACL, Node } from "@k2b/filegate";
export type UnixIdentity = { uid: number; gids: Set<number> };
const bits = (permissions: string) =>
  (permissions[0] === "r" ? 4 : 0) | (permissions[1] === "w" ? 2 : 0) | (permissions[2] === "x" ? 1 : 0);
/** POSIX ACL owner, named user, matching group, then other; no root bypass. */
export function permits(node: Node, acl: ACL, identity: UnixIdentity, required: number): boolean {
  const entry = (tag: string) => acl.entries.find((item) => item.tag === tag);
  const mask = bits(entry("mask")?.permissions ?? "rwx");
  let allowed: number;
  if (node.uid === identity.uid) allowed = bits(entry("owner")?.permissions ?? "---");
  else {
    const user = acl.entries.find((item) => item.tag === "user" && item.id === identity.uid);
    if (user) allowed = bits(user.permissions) & mask;
    else {
      const groups = acl.entries.filter(
        (item) => (item.tag === "owningGroup" && identity.gids.has(node.gid)) || (item.tag === "group" && identity.gids.has(item.id)),
      );
      if (groups.length) return groups.some((group) => (bits(group.permissions) & mask & required) === required);
      allowed = bits(entry("other")?.permissions ?? "---");
    }
  }
  return (allowed & required) === required;
}
