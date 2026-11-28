import { sql } from "@k2b/cloud";
import type { AccessSubject } from "@k2b/cloud/server";
import { buildSpacePrincipalCondition } from "./access";

declare const reached: unique symbol;

/**
 * The ids of the Spaces one subject reaches, read with that subject's own grants. Cross-Space reads filter by these
 * ids instead of checking the grants per row, so they accept only this type: ids that nobody checked cannot pass.
 * Only this module makes one (`listReachableSpaceIds`, `reachableSpaces`); it is not part of `spacesService`.
 */
export type ReachableSpaceIds = readonly string[] & { readonly [reached]: true };

/** The Spaces a subject reaches as `spaces.list` returned them for it, with their ids for the cross-Space reads. */
export type ReachableSpaces<S extends { id: string }> = { spaces: S[]; ids: ReachableSpaceIds };

const brand = (ids: readonly string[]) => ids as ReachableSpaceIds;

/**
 * The ids of every Space the subject reaches through a grant above `none`, in one statement. Cross-Space reads filter
 * by these ids rather than checking the grants per row: the planner cannot estimate the group-recursive principal
 * predicate per row and scans every item, while `space_id = ANY(ids)` keeps it on the space_id indexes.
 */
export const listReachableSpaceIds = async (subject: AccessSubject): Promise<ReachableSpaceIds> => {
  const rows = await sql<{ space_id: string }[]>`
    SELECT DISTINCT sa.space_id
    FROM spaces.space_access sa
    JOIN auth.access a ON a.id = sa.access_id
    WHERE a.permission <> 'none' AND ${buildSpacePrincipalCondition(subject)}
  `;
  return brand(rows.map((row) => row.space_id));
};

/**
 * Pairs the Spaces that `spaces.list` returned for a subject with their ids. Only for that list: it is the subject's
 * grants that made it (loadReachableSpaces).
 */
export const reachableSpaces = <S extends { id: string }>(listed: S[]): ReachableSpaces<S> => ({
  spaces: listed,
  ids: brand(listed.map((space) => space.id)),
});

/** The ids as the array a SQL `ANY(…)` binds. */
export const reachableIdsForSql = (ids: ReachableSpaceIds): string[] => [...ids];
