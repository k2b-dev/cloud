import type { BaseActivity } from "../../../service/base-activity";

/** A record that changed last, as the base home shows it: public ids, the person with the address of their picture. */
export type HomeRecentChange = {
  tableId: string;
  recordShortId: string;
  title: string | null;
  updatedAt: string;
  person: { name: string; image?: string } | null;
};

/** The activity of a base for its home, with public table ids only. */
export type HomeActivity = {
  total: number;
  /** New records per day, oldest first, today last. */
  points: number[];
  /** Per public table id: live records and, for the first tables, new ones per day. */
  tables: Record<string, { total: number; points: number[] | null }>;
  pendingFinalizations: number;
  failedRuns24h: number;
  recent: HomeRecentChange[];
};

/**
 * The server's activity for the browser: internal table ids become their public ones (a table the map does not name
 * leaves), a person becomes a name and a picture address.
 */
export const toHomeActivity = (activity: BaseActivity, publicTableIds: ReadonlyMap<string, string>): HomeActivity => ({
  total: activity.total,
  points: activity.points,
  tables: Object.fromEntries(
    Object.entries(activity.tables).flatMap(([id, table]) => {
      const publicId = publicTableIds.get(id);
      return publicId ? [[publicId, table]] : [];
    }),
  ),
  pendingFinalizations: activity.pendingFinalizations,
  failedRuns24h: activity.failedRuns24h,
  recent: activity.recent.flatMap((change) => {
    const tableId = publicTableIds.get(change.tableId);
    if (!tableId) return [];
    const user = change.user;
    return [
      {
        tableId,
        recordShortId: change.recordShortId,
        title: change.title,
        updatedAt: change.updatedAt,
        person: user?.name
          ? {
              name: user.name,
              ...(user.avatarHash
                ? { image: `/api/accounts/users/${encodeURIComponent(user.id)}/avatar?rev=${encodeURIComponent(user.avatarHash)}` }
                : {}),
            }
          : null,
      },
    ];
  }),
});
