/** A directory user: its login name and FreeIPA's immutable entry ID (`ipaEntryId`), when the directory returned one. */
export type IpaIdentity = {
  uid: string;
  entryId: string | null;
};

/** A local FreeIPA account and the directory entry ID stored at its last sync; null until a sync binds it. */
export type LocalIpaIdentity = IpaIdentity & { id: string };

/**
 * `matched`: the same directory user. `unverified`: the account stores an entry ID, the directory returned none, so
 * the record neither confirms nor replaces it. `conflict`: the username now belongs to another directory entry.
 */
export type IpaIdentityMatch<T extends LocalIpaIdentity> =
  | { kind: "matched"; row: T }
  | { kind: "unverified"; row: T }
  | { kind: "conflict"; row: T }
  | { kind: "none" };

/**
 * Finds the local account of a directory user by directory identity, never by email. A stored entry ID wins:
 * the same ID under a new name is a rename. An account without a stored ID matches by name once, and the sync
 * then stores the ID. A name whose account stores another entry ID belongs to someone else: a conflict.
 */
export const createIpaIdentityMatcher = <T extends LocalIpaIdentity>(rows: T[]) => {
  const byEntryId = new Map(rows.flatMap((row) => (row.entryId ? [[row.entryId, row] as const] : [])));
  const byUid = new Map(rows.map((row) => [row.uid, row]));
  return (remote: IpaIdentity): IpaIdentityMatch<T> => {
    const byId = remote.entryId ? byEntryId.get(remote.entryId) : undefined;
    if (byId) return { kind: "matched", row: byId };
    const byName = byUid.get(remote.uid);
    if (!byName) return { kind: "none" };
    if (!byName.entryId) return { kind: "matched", row: byName };
    return remote.entryId ? { kind: "conflict", row: byName } : { kind: "unverified", row: byName };
  };
};

export const readCompleteIpaList = (params: {
  response: {
    result: { result?: unknown; truncated?: unknown } | null;
    error: { message: string } | null;
  };
  entity: string;
}): Record<string, unknown>[] => {
  if (params.response.error) {
    throw new Error(`IPA ${params.entity} fetch failed: ${params.response.error.message}`);
  }
  const records = params.response.result?.result;
  if (!Array.isArray(records)) {
    throw new Error(`IPA ${params.entity} fetch returned invalid list payload`);
  }
  if (params.response.result?.truncated === true) {
    throw new Error(`IPA ${params.entity} fetch returned a truncated snapshot`);
  }
  if (params.response.result?.truncated !== false) {
    throw new Error(`IPA ${params.entity} fetch returned invalid completeness metadata`);
  }
  return records as Record<string, unknown>[];
};

export type IpaDestructionGuardLimits = {
  maxUserChanges: number;
  maxUserChangePercent: number;
  maxGroupDeletions: number;
  maxGroupDeletionPercent: number;
};

export type IpaDestructionGuardReport = {
  userChanges: number;
  userChangePercent: number;
  localUsers: number;
  groupDeletions: number;
  groupDeletionPercent: number;
  localGroups: number;
  limits: IpaDestructionGuardLimits;
  violations: Array<"user_count" | "user_percent" | "group_count" | "group_percent">;
};

/** Local accounts that no active directory user matches by identity. A record without an entry ID proves no departure. */
export const selectStaleLocalIpaRows = <T extends LocalIpaIdentity>(params: { localRows: T[]; activeRemoteUsers: IpaIdentity[] }): T[] => {
  const match = createIpaIdentityMatcher(params.localRows);
  const present = new Set<string>();
  for (const remote of params.activeRemoteUsers) {
    const result = match(remote);
    if (result.kind === "matched" || result.kind === "unverified") present.add(result.row.id);
  }
  return params.localRows.filter((row) => !present.has(row.id));
};

const percentage = (affected: number, total: number): number => {
  if (affected === 0) return 0;
  if (total <= 0) return 100;
  return (affected / total) * 100;
};

export const assessIpaDestructionGuard = (params: {
  affectedUserIds: Iterable<string>;
  localUsers: number;
  deletedGroupNames: Iterable<string>;
  localGroups: number;
  limits: IpaDestructionGuardLimits;
}): IpaDestructionGuardReport => {
  const userChanges = new Set(params.affectedUserIds).size;
  const groupDeletions = new Set(params.deletedGroupNames).size;
  const userChangePercent = percentage(userChanges, params.localUsers);
  const groupDeletionPercent = percentage(groupDeletions, params.localGroups);
  const violations: IpaDestructionGuardReport["violations"] = [];

  if (userChanges > params.limits.maxUserChanges) violations.push("user_count");
  if (userChangePercent > params.limits.maxUserChangePercent) violations.push("user_percent");
  if (groupDeletions > params.limits.maxGroupDeletions) violations.push("group_count");
  if (groupDeletionPercent > params.limits.maxGroupDeletionPercent) violations.push("group_percent");

  return {
    userChanges,
    userChangePercent,
    localUsers: params.localUsers,
    groupDeletions,
    groupDeletionPercent,
    localGroups: params.localGroups,
    limits: params.limits,
    violations,
  };
};

export const formatIpaDestructionGuardFailure = (report: IpaDestructionGuardReport): string =>
  `Refusing IPA sync: destructive plan exceeds configured guard limits ` +
  `(users ${report.userChanges}/${report.localUsers} = ${report.userChangePercent.toFixed(2)}%, ` +
  `limits ${report.limits.maxUserChanges} and ${report.limits.maxUserChangePercent}%; ` +
  `groups ${report.groupDeletions}/${report.localGroups} = ${report.groupDeletionPercent.toFixed(2)}%, ` +
  `limits ${report.limits.maxGroupDeletions} and ${report.limits.maxGroupDeletionPercent}%; ` +
  `violations: ${report.violations.join(", ")})`;
