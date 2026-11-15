import type { CodeCheckedVersionManifest } from "@k2b/cloud/contracts";

const permissionKey = (permission: { operation: string; target: { type: string; id: string | null } | null }) =>
  `${permission.operation}|${permission.target?.type ?? ""}|${permission.target?.id ?? ""}`;

/** Compare permissions of the reviewed version with the comparison version, deduplicated by operation and target. */
export function codeAdminPermissionChanges(
  current: CodeCheckedVersionManifest["permissions"],
  previous: CodeCheckedVersionManifest["permissions"] | null,
) {
  const before = new Map((previous ?? []).map((permission) => [permissionKey(permission), permission]));
  const seen = new Set<string>();
  const changes: (CodeCheckedVersionManifest["permissions"][number] & { change: "same" | "added" | "removed" })[] = [];
  for (const permission of current) {
    const key = permissionKey(permission);
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push({ ...permission, change: before.has(key) ? "same" : "added" });
  }
  for (const [key, permission] of before) if (!seen.has(key)) changes.push({ ...permission, change: "removed" });
  const order = { added: 0, same: 1, removed: 2 } as const;
  return changes.sort((a, b) => order[a.change] - order[b.change]);
}
