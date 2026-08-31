import { type DateContext, dates } from "@k2b/stdlib";
import { type AccessSubject, type AccessUser, listUsersWithAccess } from "@valentinkolb/cloud/server";
import { logger, toPgTextArray, toPgUuidArray } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import type {
  AssignedToFilter,
  CalendarItem,
  CreateItem,
  ItemFilter,
  ItemListResult,
  ItemType,
  MutationResult,
  OverlapItem,
  Priority,
  Recurrence,
  SpaceAssignableUser,
  SpaceItem,
  SpaceItemAssignee,
  SpaceTag,
  SplitRecurringItem,
  UpdateItem,
} from "@/contracts";
import { INACTIVE_ITEM_DAYS } from "@/contracts";
import { withShortId } from "../lib/short-id";
import { buildSpacePrincipalCondition, isSpaceResourceId } from "./access";
import type { SpaceActivityIdentity } from "./activity";
import * as activity from "./activity";
import { descriptionPreview } from "./description-preview";
import { publishSpaceEvent } from "./events";
import { insertMany as insertItemResourceReferences } from "./item-resource-references";
import { rank } from "./rank";
import {
  type ExpandedRecurringEvent,
  expandRecurringEvents,
  parseRecurrenceRule,
  type RecurringEvent,
  type RecurringOverride,
  resolveRecurringOccurrence,
  shiftRecurrenceRule,
  splitRecurringEvent,
} from "./recurrence";

// ==========================
// Items Service
// ==========================

type SqlExecutor = typeof sql;
const log = logger("spaces:items");
const systemActor: SpaceActivityIdentity = { kind: "system", id: null };
const hourBucket = () => {
  const value = new Date();
  value.setUTCMinutes(0, 0, 0);
  return value;
};

type CalendarEventPersistence = {
  title: string;
  description: string | null;
  location: string | null;
  url: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  recurrenceRule: string | null;
};

type DbItem = {
  id: string;
  space_id: string;
  column_id: string;
  title: string;
  description: string | null;
  location: string | null;
  url: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  all_day: boolean;
  deadline: Date | null;
  estimated_duration_minutes: number | null;
  priority: string | null;
  recurrence_rrule: string | null;
  recurrence_dtstart: Date | null;
  recurrence_exdate: Date[] | null;
  recurring_event_id: string | null;
  recurrence_id: Date | null;
  rank: string;
  completed_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

type DbCalendarItem = {
  id: string;
  space_id: string;
  space_name: string;
  space_color: string;
  title: string;
  description: string | null;
  location: string | null;
  url: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  all_day: boolean;
  deadline: Date | null;
  priority: string | null;
  recurrence_rrule: string | null;
  recurrence_dtstart: Date | null;
  recurrence_exdate: Date[] | null;
  recurring_event_id: string | null;
  recurrence_id: Date | null;
};

type DbOverlapItem = {
  item_id: string;
  space_id: string;
  space_name: string;
  title: string;
  starts_at: Date;
  ends_at: Date;
};

type DbItemAssignee = {
  item_id: string;
  id: string;
  display_name: string;
  avatar_hash: string | null;
};

type DbItemTag = {
  item_id: string;
  id: string;
  space_id: string;
  name: string;
  color: string;
};

const mapRecurrence = (row: Pick<DbItem, "recurrence_rrule" | "recurrence_dtstart" | "recurrence_exdate">): Recurrence | null => {
  if (!row.recurrence_rrule) return null;
  return {
    rrule: row.recurrence_rrule,
    dtstart: row.recurrence_dtstart?.toISOString() ?? null,
    exdate: (row.recurrence_exdate ?? []).map((date) => date.toISOString()),
  };
};

const toPgTimestampArray = (values: string[]): string => `{${values.map((value) => `"${new Date(value).toISOString()}"`).join(",")}}`;

const recurrenceValues = (recurrence: Recurrence | null | undefined) => ({
  rrule: recurrence?.rrule ?? null,
  dtstart: recurrence?.dtstart ?? null,
  exdate: recurrence?.exdate && recurrence.exdate.length > 0 ? toPgTimestampArray(recurrence.exdate) : null,
});

export const persistCalendarEvent = async (params: {
  db: SqlExecutor;
  spaceId: string;
  itemId: string | null;
  createdBy: string;
  completed: boolean;
  shortId: string;
  data: CalendarEventPersistence;
}): Promise<MutationResult<{ id: string; created: boolean }>> => {
  if (new Date(params.data.endsAt).getTime() <= new Date(params.data.startsAt).getTime()) {
    return { ok: false, error: "End time must be after start time", status: 400 };
  }
  if (params.data.recurrenceRule) {
    try {
      parseRecurrenceRule(params.data.recurrenceRule);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Invalid recurrence rule", status: 400 };
    }
  }

  if (!params.itemId) {
    const [column] = await params.db<{ id: string }[]>`
      SELECT id FROM spaces.columns
      WHERE space_id = ${params.spaceId}::uuid
      ORDER BY is_done, rank, id
      LIMIT 1
    `;
    if (!column) return { ok: false, error: "The destination Space needs an open column", status: 400 };
    const [created] = await params.db<{ id: string }[]>`
      INSERT INTO spaces.items (
        short_id, space_id, column_id, title, description, location, url, starts_at, ends_at, all_day,
        recurrence_rrule, recurrence_dtstart, recurrence_exdate, rank, created_by
      ) VALUES (
        ${params.shortId}, ${params.spaceId}::uuid, ${column.id}::uuid, ${params.data.title}, ${params.data.description},
        ${params.data.location}, ${params.data.url}, ${params.data.startsAt}::timestamptz, ${params.data.endsAt}::timestamptz,
        ${params.data.allDay}, ${params.data.recurrenceRule},
        ${params.data.recurrenceRule ? params.data.startsAt : null}::timestamptz,
        CASE WHEN ${params.data.recurrenceRule}::text IS NULL THEN NULL ELSE ARRAY[]::timestamptz[] END,
        COALESCE((SELECT MAX(rank) + 1024 FROM spaces.items WHERE column_id = ${column.id}::uuid), 1024),
        ${params.createdBy}::uuid
      )
      RETURNING id
    `;
    return created
      ? { ok: true, data: { id: created.id, created: true } }
      : { ok: false, error: "Could not create the calendar event", status: 500 };
  }

  const [current] = await params.db<
    { space_id: string; starts_at: Date | null; recurrence_rrule: string | null; recurring_event_id: string | null }[]
  >`
    SELECT space_id, starts_at, recurrence_rrule, recurring_event_id
    FROM spaces.items
    WHERE id = ${params.itemId}::uuid
    FOR UPDATE
  `;
  if (!current || current.space_id !== params.spaceId) return { ok: false, error: "Event not found", status: 404 };
  if (params.data.recurrenceRule && current.recurring_event_id) {
    return { ok: false, error: "Recurring series cannot also be an override", status: 400 };
  }
  const seriesShiftMilliseconds =
    current.recurrence_rrule && params.data.recurrenceRule && !current.recurring_event_id && current.starts_at
      ? new Date(params.data.startsAt).getTime() - current.starts_at.getTime()
      : 0;
  await params.db`
    UPDATE spaces.items
    SET title = ${params.data.title},
        description = ${params.data.description},
        location = ${params.data.location},
        url = ${params.data.url},
        starts_at = ${params.data.startsAt}::timestamptz,
        ends_at = ${params.data.endsAt}::timestamptz,
        all_day = ${params.data.allDay},
        recurrence_rrule = ${params.data.recurrenceRule},
        recurrence_dtstart = ${params.data.recurrenceRule ? params.data.startsAt : null}::timestamptz,
        recurrence_exdate = CASE
          WHEN ${params.data.recurrenceRule}::text IS NULL THEN NULL
          ELSE ARRAY[]::timestamptz[]
        END,
        updated_at = now()
    WHERE id = ${params.itemId}::uuid
  `;
  if (seriesShiftMilliseconds !== 0) {
    const interval = sql`(${seriesShiftMilliseconds}::double precision * interval '1 millisecond')`;
    await params.db`
      UPDATE spaces.items
      SET recurrence_id = recurrence_id + ${interval},
          starts_at = starts_at + ${interval},
          ends_at = ends_at + ${interval},
          updated_at = now()
      WHERE recurring_event_id = ${params.itemId}::uuid
        AND recurrence_id IS NOT NULL
    `;
    await params.db`
      UPDATE spaces.comments
      SET recurrence_id = recurrence_id + ${interval}
      WHERE item_id = ${params.itemId}::uuid
        AND recurrence_id IS NOT NULL
    `;
  }
  if (params.completed) {
    await params.db`
      WITH current_item AS (
        SELECT item.id, item.space_id, item.column_id, column_state.is_done AS column_is_done
        FROM spaces.items item
        JOIN spaces.columns column_state ON column_state.id = item.column_id
        WHERE item.id = ${params.itemId}::uuid
      ), target_column AS (
        SELECT COALESCE(
          (SELECT column_id FROM current_item WHERE column_is_done),
          (
            SELECT candidate.id
            FROM spaces.columns candidate
            JOIN current_item current_item_row ON current_item_row.space_id = candidate.space_id
            WHERE candidate.is_done
            ORDER BY candidate.rank ASC
            LIMIT 1
          )
        ) AS id
      ), target_rank AS (
        SELECT COALESCE(MAX(item.rank), 0) + 1024 AS value
        FROM spaces.items item
        JOIN target_column target ON target.id = item.column_id
      )
      UPDATE spaces.items item
      SET completed_at = now(),
          column_id = COALESCE((SELECT id FROM target_column), item.column_id),
          rank = CASE
            WHEN (SELECT id FROM target_column) IS DISTINCT FROM item.column_id THEN (SELECT value FROM target_rank)
            ELSE item.rank
          END,
          updated_at = now()
      WHERE item.id = ${params.itemId}::uuid
    `;
  }
  return { ok: true, data: { id: params.itemId, created: false } };
};

const shiftIsoInstant = (value: string, milliseconds: number) => new Date(new Date(value).getTime() + milliseconds).toISOString();

const replaceItemAssignees = async (db: SqlExecutor, itemId: string, userIds: string[]): Promise<void> => {
  await db`DELETE FROM spaces.item_assignees WHERE item_id = ${itemId}`;

  for (const userId of userIds) {
    await db`
      INSERT INTO spaces.item_assignees (item_id, user_id)
      VALUES (${itemId}, ${userId})
      ON CONFLICT DO NOTHING
    `;
  }
};

const replaceItemTags = async (db: SqlExecutor, itemId: string, tagIds: string[]): Promise<void> => {
  await db`DELETE FROM spaces.item_tags WHERE item_id = ${itemId}`;

  for (const tagId of tagIds) {
    await db`
      INSERT INTO spaces.item_tags (item_id, tag_id)
      VALUES (${itemId}, ${tagId})
      ON CONFLICT DO NOTHING
    `;
  }
};

const listSpaceAccessIds = async (spaceId: string): Promise<string[]> => {
  const rows = await sql<{ access_id: string }[]>`
    SELECT access_id
    FROM spaces.space_access
    WHERE space_id = ${spaceId}::uuid
  `;
  return rows.map((row) => row.access_id);
};

const assignableUserDescription = (user: AccessUser): string => {
  const source = user.source.type === "direct" ? "direct access" : `via ${user.source.groupName}`;
  return `${user.uid} · ${source}`;
};

const uniqueIds = (ids: string[] | undefined): string[] => [...new Set(ids ?? [])];

export const listAssignableUsers = async (params: {
  spaceId: string;
  search?: string;
  excludeUserIds?: string[];
  limit?: number;
}): Promise<SpaceAssignableUser[]> => {
  const accessIds = await listSpaceAccessIds(params.spaceId);
  const users = await listUsersWithAccess({
    accessIds,
    search: params.search,
    excludeUserIds: params.excludeUserIds,
    limit: params.limit,
  });

  return users.map((user) => ({
    id: user.id,
    displayName: user.displayName,
    avatarHash: user.avatarHash,
    description: assignableUserDescription(user),
  }));
};

const validateAssigneeIdsInSpace = async (spaceId: string, assigneeIds: string[] | undefined): Promise<MutationResult<void>> => {
  const ids = uniqueIds(assigneeIds);
  if (ids.length === 0) return { ok: true, data: undefined };

  const accessIds = await listSpaceAccessIds(spaceId);
  const users = await listUsersWithAccess({
    accessIds,
    userIds: ids,
    limit: ids.length,
  });
  const validIds = new Set(users.map((user) => user.id));
  const invalidCount = ids.filter((id) => !validIds.has(id)).length;

  if (invalidCount > 0) {
    return {
      ok: false,
      error: invalidCount === 1 ? "Assignee must have access to this space" : "Assignees must have access to this space",
      status: 400,
    };
  }
  return { ok: true, data: undefined };
};

const validateRecurrenceInput = async (params: {
  spaceId: string;
  startsAt: string | null | undefined;
  endsAt: string | null | undefined;
  recurrence: Recurrence | null | undefined;
  recurringEventId: string | null | undefined;
  recurrenceId: string | null | undefined;
  dateConfig?: DateContext;
}, db: SqlExecutor = sql): Promise<MutationResult<void>> => {
  const isSeries = !!params.recurrence?.rrule;
  const isOverride = !!params.recurringEventId || !!params.recurrenceId;

  if (isSeries && isOverride) {
    return { ok: false, error: "Recurring series cannot also be an override", status: 400 };
  }
  if (isSeries && (!params.startsAt || !params.endsAt)) {
    return { ok: false, error: "Recurring events require start and end times", status: 400 };
  }
  if (isSeries) {
    try {
      parseRecurrenceRule(params.recurrence!.rrule);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Invalid recurrence rule", status: 400 };
    }
  }
  if (isOverride) {
    if (!params.recurringEventId || !params.recurrenceId) {
      return { ok: false, error: "Recurring overrides require parent event and recurrence id", status: 400 };
    }
    if (!params.startsAt || !params.endsAt) {
      return { ok: false, error: "Recurring overrides require start and end times", status: 400 };
    }
    const [parent] = await db<
      {
        id: string;
        title: string;
        starts_at: Date;
        ends_at: Date;
        all_day: boolean;
        recurrence_rrule: string;
        recurrence_dtstart: Date | null;
        recurrence_exdate: Date[] | null;
      }[]
    >`
      SELECT id, title, starts_at, ends_at, all_day, recurrence_rrule, recurrence_dtstart, recurrence_exdate
      FROM spaces.items
      WHERE id = ${params.recurringEventId}
        AND space_id = ${params.spaceId}
        AND recurrence_rrule IS NOT NULL
        AND recurring_event_id IS NULL
    `;
    if (!parent) {
      return { ok: false, error: "Parent recurring event not found in space", status: 400 };
    }
    const occurrence = resolveRecurringOccurrence({
      event: {
        id: parent.id,
        title: parent.title,
        start: parent.starts_at,
        end: parent.ends_at,
        allDay: parent.all_day,
        recurrence: {
          rrule: parent.recurrence_rrule,
          dtstart: parent.recurrence_dtstart ?? parent.starts_at,
          exdate: parent.recurrence_exdate ?? [],
        },
      },
      recurrenceId: params.recurrenceId!,
      dateConfig: params.dateConfig,
    });
    if (!occurrence) {
      return { ok: false, error: "Recurring occurrence not found", status: 400 };
    }
  }

  return { ok: true, data: undefined };
};

const validateTagIdsInSpace = async (spaceId: string, tagIds: string[] | undefined): Promise<MutationResult<void>> => {
  if (!tagIds || tagIds.length === 0) return { ok: true, data: undefined };
  const uniqueTagIds = [...new Set(tagIds)];
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM spaces.tags
    WHERE space_id = ${spaceId} AND id = ANY(${toPgUuidArray(uniqueTagIds)}::uuid[])
  `;
  if ((row?.count ?? 0) !== uniqueTagIds.length) {
    return { ok: false, error: "Tag not found in space", status: 400 };
  }
  return { ok: true, data: undefined };
};

/**
 * Converts one item row from `spaces.items` into the API-facing `SpaceItem` object.
 */
const mapToItem = (row: DbItem): SpaceItem => ({
  id: row.id,
  spaceId: row.space_id,
  columnId: row.column_id,
  title: row.title,
  description: row.description,
  location: row.location,
  url: row.url,
  startsAt: row.starts_at?.toISOString() ?? null,
  endsAt: row.ends_at?.toISOString() ?? null,
  allDay: row.all_day,
  deadline: row.deadline?.toISOString() ?? null,
  estimatedDurationMinutes: row.estimated_duration_minutes,
  activeBlockerCount: 0,
  priority: (row.priority as Priority) ?? null,
  recurrence: mapRecurrence(row),
  recurringEventId: row.recurring_event_id,
  recurrenceId: row.recurrence_id?.toISOString() ?? null,
  rank: row.rank,
  completedAt: row.completed_at?.toISOString() ?? null,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  lastActivityAt: row.updated_at.toISOString(),
});

/**
 * Get assignees for an item
 */
const getAssignees = async (itemId: string): Promise<SpaceItemAssignee[]> => {
  const rows = await sql<{ id: string; display_name: string; avatar_hash: string | null }[]>`
    SELECT u.id, u.display_name, u.avatar_hash
    FROM spaces.item_assignees ia
    JOIN auth.users u ON ia.user_id = u.id
    WHERE ia.item_id = ${itemId}
    ORDER BY u.display_name
  `;
  return rows.map((r) => ({ id: r.id, displayName: r.display_name, avatarHash: r.avatar_hash }));
};

/**
 * Get tags for an item
 */
const getTags = async (itemId: string): Promise<SpaceTag[]> => {
  const rows = await sql<{ id: string; space_id: string; name: string; color: string }[]>`
    SELECT t.id, t.space_id, t.name, t.color
    FROM spaces.item_tags it
    JOIN spaces.tags t ON it.tag_id = t.id
    WHERE it.item_id = ${itemId}
    ORDER BY t.name
  `;
  return rows.map((r) => ({
    id: r.id,
    spaceId: r.space_id,
    name: r.name,
    color: r.color,
  }));
};

const getAssigneesByItemIds = async (itemIds: string[]): Promise<Map<string, SpaceItemAssignee[]>> => {
  if (itemIds.length === 0) return new Map();
  const rows = await sql<DbItemAssignee[]>`
    SELECT ia.item_id, u.id, u.display_name, u.avatar_hash
    FROM spaces.item_assignees ia
    JOIN auth.users u ON ia.user_id = u.id
    WHERE ia.item_id = ANY(${toPgUuidArray(itemIds)}::uuid[])
    ORDER BY ia.item_id, u.display_name
  `;
  const grouped = new Map<string, SpaceItemAssignee[]>();
  for (const row of rows) {
    grouped.set(row.item_id, [
      ...(grouped.get(row.item_id) ?? []),
      { id: row.id, displayName: row.display_name, avatarHash: row.avatar_hash },
    ]);
  }
  return grouped;
};

const getTagsByItemIds = async (itemIds: string[]): Promise<Map<string, SpaceTag[]>> => {
  if (itemIds.length === 0) return new Map();
  const rows = await sql<DbItemTag[]>`
    SELECT it.item_id, t.id, t.space_id, t.name, t.color
    FROM spaces.item_tags it
    JOIN spaces.tags t ON it.tag_id = t.id
    WHERE it.item_id = ANY(${toPgUuidArray(itemIds)}::uuid[])
    ORDER BY it.item_id, t.name
  `;
  const grouped = new Map<string, SpaceTag[]>();
  for (const row of rows) {
    grouped.set(row.item_id, [
      ...(grouped.get(row.item_id) ?? []),
      {
        id: row.id,
        spaceId: row.space_id,
        name: row.name,
        color: row.color,
      },
    ]);
  }
  return grouped;
};

const getActiveBlockerCountsByItemIds = async (itemIds: string[]): Promise<Map<string, number>> => {
  if (itemIds.length === 0) return new Map();
  const rows = await sql<{ item_id: string; count: number }[]>`
    SELECT dependency.item_id, COUNT(*)::int AS count
    FROM spaces.item_dependencies dependency
    JOIN spaces.items blocker ON blocker.id = dependency.blocker_item_id
    WHERE dependency.item_id = ANY(${toPgUuidArray(itemIds)}::uuid[])
      AND blocker.completed_at IS NULL
    GROUP BY dependency.item_id
  `;
  return new Map(rows.map((row) => [row.item_id, row.count]));
};

const getLastActivityByItemIds = async (itemIds: string[]): Promise<Map<string, string>> => {
  if (itemIds.length === 0) return new Map();
  const rows = await sql<{ item_id: string; last_activity_at: Date }[]>`
    SELECT item_id, MAX(last_occurred_at) AS last_activity_at
    FROM spaces.activity_events
    WHERE item_id = ANY(${toPgUuidArray(itemIds)}::uuid[])
    GROUP BY item_id
  `;
  return new Map(rows.map((row) => [row.item_id, row.last_activity_at.toISOString()]));
};

const hydrateRelations = async (items: SpaceItem[]): Promise<SpaceItem[]> => {
  if (items.length === 0) return items;
  const itemIds = items.map((item) => item.id);
  const [assigneesByItemId, tagsByItemId, blockerCountsByItemId, lastActivityByItemId] = await Promise.all([
    getAssigneesByItemIds(itemIds),
    getTagsByItemIds(itemIds),
    getActiveBlockerCountsByItemIds(itemIds),
    getLastActivityByItemIds(itemIds),
  ]);
  for (const item of items) {
    item.assignees = assigneesByItemId.get(item.id) ?? [];
    item.tags = tagsByItemId.get(item.id) ?? [];
    item.activeBlockerCount = blockerCountsByItemId.get(item.id) ?? 0;
    item.lastActivityAt = lastActivityByItemId.get(item.id) ?? item.updatedAt;
  }
  return items;
};

const deadlineWindow = (dateConfig?: DateContext) => {
  const todayStart = dates.today(dateConfig);
  return {
    todayStart: todayStart.toISOString(),
    tomorrowStart: dates.addDays(todayStart, 1, dateConfig).toISOString(),
    weekEnd: dates.addDays(todayStart, 7, dateConfig).toISOString(),
  };
};

/**
 * Dashboard widget query: today's events and the next deadlines, across
 * every space the user can reach (direct user grant, group grant,
 * authenticated_only, or fully public). One SQL roundtrip.
 *
 * - "Events today" = items with `starts_at` or `deadline` falling inside
 *   the current day in the caller's date context, ignoring already-completed.
 * - "Next deadlines" = open items (not in is_done columns and not
 *   completed) ordered by deadline ASC NULLS LAST, then created_at.
 */
export type DashboardItem = {
  id: string;
  shortId: string;
  spaceId: string;
  spaceShortId: string;
  spaceName: string;
  spaceColor: string | null;
  spaceIcalToken: string | null;
  title: string;
  priority: "low" | "medium" | "high" | "urgent" | null;
  startsAt: string | null;
  endsAt: string | null;
  deadline: string | null;
};

export const dashboardSnapshot = async (params: {
  userId: string;
  todoLimit: number;
  dateConfig?: DateContext;
}): Promise<{
  openTodoCount: number;
  assignedToMeCount: number;
  urgentCount: number;
  todayCount: number;
  upcomingCount: number;
  events: DashboardItem[];
  todos: DashboardItem[];
}> => {
  const principalMatch = buildSpacePrincipalCondition({ type: "user", userId: params.userId });
  const { todayStart, tomorrowStart } = deadlineWindow(params.dateConfig);

  // Open-todo aggregate (count + urgent-count) across all reachable spaces.
  const [agg] = await sql<
    {
      open_count: number;
      assigned_count: number;
      urgent_count: number;
      today_count: number;
      upcoming_count: number;
    }[]
  >`
    SELECT
      COUNT(*) FILTER (WHERE i.completed_at IS NULL AND c.is_done = false)::int AS open_count,
      COUNT(*) FILTER (
        WHERE i.completed_at IS NULL AND c.is_done = false
          AND EXISTS (SELECT 1 FROM spaces.item_assignees ia WHERE ia.item_id = i.id AND ia.user_id = ${params.userId}::uuid)
      )::int AS assigned_count,
      COUNT(*) FILTER (WHERE i.completed_at IS NULL AND c.is_done = false AND i.priority = 'urgent')::int AS urgent_count,
      COUNT(*) FILTER (
        WHERE i.completed_at IS NULL AND (
          (i.starts_at IS NOT NULL AND i.starts_at >= ${todayStart}::timestamptz AND i.starts_at < ${tomorrowStart}::timestamptz)
          OR (i.deadline IS NOT NULL AND i.deadline >= ${todayStart}::timestamptz AND i.deadline < ${tomorrowStart}::timestamptz)
        )
      )::int AS today_count,
      COUNT(*) FILTER (
        WHERE i.completed_at IS NULL AND c.is_done = false
          AND (i.starts_at IS NULL OR i.starts_at < ${todayStart}::timestamptz OR i.starts_at >= ${tomorrowStart}::timestamptz)
      )::int AS upcoming_count
    FROM spaces.items i
    JOIN spaces.columns c ON c.id = i.column_id
    JOIN spaces.spaces s ON s.id = i.space_id
    WHERE EXISTS (
      SELECT 1 FROM spaces.space_access sa
      JOIN auth.access a ON a.id = sa.access_id
      WHERE sa.space_id = i.space_id
        AND a.permission <> 'none'
        AND ${principalMatch}
    )
  `;

  type DbWidget = {
    id: string;
    short_id: string;
    space_id: string;
    space_short_id: string;
    space_name: string;
    space_color: string | null;
    space_ical: string | null;
    title: string;
    priority: "low" | "medium" | "high" | "urgent" | null;
    starts_at: string | null;
    ends_at: string | null;
    deadline: string | null;
  };

  // Today's events: starts_at within today's window OR deadline within today.
  const eventRows = await sql<DbWidget[]>`
    SELECT i.id, i.short_id, i.space_id, s.short_id AS space_short_id, s.name AS space_name, s.color AS space_color, s.ical_token AS space_ical,
           i.title, i.priority,
           i.starts_at::text AS starts_at, i.ends_at::text AS ends_at, i.deadline::text AS deadline
    FROM spaces.items i
    JOIN spaces.spaces s ON s.id = i.space_id
    WHERE i.completed_at IS NULL
      AND (
        (i.starts_at IS NOT NULL AND i.starts_at >= ${todayStart}::timestamptz AND i.starts_at < ${tomorrowStart}::timestamptz)
        OR (i.deadline IS NOT NULL AND i.deadline >= ${todayStart}::timestamptz AND i.deadline < ${tomorrowStart}::timestamptz)
      )
      AND EXISTS (
        SELECT 1 FROM spaces.space_access sa
        JOIN auth.access a ON a.id = sa.access_id
        WHERE sa.space_id = i.space_id
          AND a.permission <> 'none'
          AND ${principalMatch}
      )
    ORDER BY COALESCE(i.starts_at, i.deadline) ASC
    LIMIT 5
  `;

  // Next-up todos: open, not in is_done columns, ordered by deadline.
  const todoRows = await sql<DbWidget[]>`
    SELECT i.id, i.short_id, i.space_id, s.short_id AS space_short_id, s.name AS space_name, s.color AS space_color, s.ical_token AS space_ical,
           i.title, i.priority,
           i.starts_at::text AS starts_at, i.ends_at::text AS ends_at, i.deadline::text AS deadline
    FROM spaces.items i
    JOIN spaces.columns c ON c.id = i.column_id
    JOIN spaces.spaces s ON s.id = i.space_id
    WHERE i.completed_at IS NULL
      AND c.is_done = false
      AND (i.starts_at IS NULL OR i.starts_at < ${todayStart}::timestamptz OR i.starts_at >= ${tomorrowStart}::timestamptz)
      AND EXISTS (
        SELECT 1 FROM spaces.space_access sa
        JOIN auth.access a ON a.id = sa.access_id
        WHERE sa.space_id = i.space_id
          AND a.permission <> 'none'
          AND ${principalMatch}
      )
    ORDER BY i.deadline ASC NULLS LAST, i.created_at ASC
    LIMIT ${params.todoLimit}
  `;

  const map = (r: DbWidget): DashboardItem => ({
    id: r.id,
    shortId: r.short_id,
    spaceId: r.space_id,
    spaceShortId: r.space_short_id,
    spaceName: r.space_name,
    spaceColor: r.space_color,
    spaceIcalToken: r.space_ical,
    title: r.title,
    priority: r.priority,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    deadline: r.deadline,
  });

  return {
    openTodoCount: agg?.open_count ?? 0,
    assignedToMeCount: agg?.assigned_count ?? 0,
    urgentCount: agg?.urgent_count ?? 0,
    todayCount: agg?.today_count ?? 0,
    upcomingCount: agg?.upcoming_count ?? 0,
    events: eventRows.map(map),
    todos: todoRows.map(map),
  };
};

/**
 * List items for a space as a plain board snapshot.
 */
export const list = async (params: { spaceId: string; includeCompleted?: boolean }): Promise<SpaceItem[]> => {
  const { spaceId, includeCompleted = false } = params;

  let rows: DbItem[];
  if (includeCompleted) {
    rows = await sql<DbItem[]>`
      SELECT
        i.id, i.space_id, i.column_id, i.title, i.description, i.location, i.url, i.starts_at, i.ends_at, i.all_day, i.deadline,
        i.estimated_duration_minutes, i.priority, i.recurrence_rrule, i.recurrence_dtstart, i.recurrence_exdate, i.recurring_event_id, i.recurrence_id,
        i.rank::text AS rank,
        i.completed_at, i.created_by, i.created_at, i.updated_at
      FROM spaces.items i
      LEFT JOIN spaces.columns c ON c.id = i.column_id
      WHERE i.space_id = ${spaceId}
      ORDER BY c.rank, i.rank
    `;
  } else {
    rows = await sql<DbItem[]>`
      SELECT
        i.id, i.space_id, i.column_id, i.title, i.description, i.location, i.url, i.starts_at, i.ends_at, i.all_day, i.deadline,
        i.estimated_duration_minutes, i.priority, i.recurrence_rrule, i.recurrence_dtstart, i.recurrence_exdate, i.recurring_event_id, i.recurrence_id,
        i.rank::text AS rank,
        i.completed_at, i.created_by, i.created_at, i.updated_at
      FROM spaces.items i
      LEFT JOIN spaces.columns c ON c.id = i.column_id
      WHERE i.space_id = ${spaceId} AND i.completed_at IS NULL
      ORDER BY c.rank, i.rank
    `;
  }

  return hydrateRelations(rows.map(mapToItem));
};

/**
 * List items with full filtering, sorting, and pagination
 * Uses parameterized queries to prevent SQL injection
 */
export const listFiltered = async (params: {
  spaceId: string;
  filter: ItemFilter;
  currentUserId?: string;
  dateConfig?: DateContext;
}): Promise<ItemListResult> => {
  const { spaceId, filter, currentUserId } = params;
  const {
    type,
    status,
    activity: activityFilter,
    priority,
    tagIds,
    assigneeIds,
    assignedTo,
    columnIds,
    deadlineFilter,
    search,
    sort,
    sortDesc,
    page,
    pageSize,
  } = filter;

  // Build WHERE conditions as SQL fragments (safe from injection)
  // Base condition - always filter by space
  let conditions = sql`i.space_id = ${spaceId}`;

  // Type filter (task vs event)
  if (type === "task") {
    conditions = sql`${conditions} AND (i.starts_at IS NULL OR i.ends_at IS NULL)`;
  } else if (type === "event") {
    conditions = sql`${conditions} AND (i.starts_at IS NOT NULL AND i.ends_at IS NOT NULL)`;
  }

  // Status filter
  if (status === "active") {
    conditions = sql`${conditions} AND i.completed_at IS NULL`;
  } else if (status === "completed") {
    conditions = sql`${conditions} AND i.completed_at IS NOT NULL`;
  }

  if (activityFilter === "inactive") {
    conditions = sql`${conditions}
      AND i.completed_at IS NULL
      AND i.starts_at IS NULL
      AND i.ends_at IS NULL
      AND COALESCE(
        (SELECT MAX(item_activity.last_occurred_at) FROM spaces.activity_events item_activity WHERE item_activity.item_id = i.id),
        i.updated_at
      ) < now() - (${INACTIVE_ITEM_DAYS} * interval '1 day')`;
  }

  // Priority filter - use IN with parameterized values
  if (priority && priority.length > 0) {
    conditions = sql`${conditions} AND i.priority = ANY(${toPgTextArray(priority)}::text[])`;
  }

  // Column filter
  if (columnIds && columnIds.length > 0) {
    conditions = sql`${conditions} AND i.column_id = ANY(${toPgUuidArray(columnIds)}::uuid[])`;
  }

  // Deadline filter
  if (deadlineFilter === "overdue") {
    const { todayStart } = deadlineWindow(params.dateConfig);
    conditions = sql`${conditions} AND i.deadline IS NOT NULL AND i.deadline < ${todayStart}::timestamptz`;
  } else if (deadlineFilter === "today") {
    const { todayStart, tomorrowStart } = deadlineWindow(params.dateConfig);
    conditions = sql`${conditions} AND i.deadline IS NOT NULL AND i.deadline >= ${todayStart}::timestamptz AND i.deadline < ${tomorrowStart}::timestamptz`;
  } else if (deadlineFilter === "week") {
    const { todayStart, weekEnd } = deadlineWindow(params.dateConfig);
    conditions = sql`${conditions} AND i.deadline IS NOT NULL AND i.deadline >= ${todayStart}::timestamptz AND i.deadline < ${weekEnd}::timestamptz`;
  } else if (deadlineFilter === "none") {
    conditions = sql`${conditions} AND i.deadline IS NULL`;
  }

  // Tag filter (items that have ANY of the specified tags)
  if (tagIds && tagIds.length > 0) {
    conditions = sql`${conditions} AND EXISTS (
      SELECT 1 FROM spaces.item_tags it
      WHERE it.item_id = i.id AND it.tag_id = ANY(${toPgUuidArray(tagIds)}::uuid[])
    )`;
  }

  // Assignee filter (items assigned to ANY of the specified users)
  if (assigneeIds && assigneeIds.length > 0) {
    conditions = sql`${conditions} AND EXISTS (
      SELECT 1 FROM spaces.item_assignees ia
      WHERE ia.item_id = i.id AND ia.user_id = ANY(${toPgUuidArray(assigneeIds)}::uuid[])
    )`;
  }

  // AssignedTo filter (all, assigned, me, unassigned)
  if (assignedTo === "assigned") {
    conditions = sql`${conditions} AND EXISTS (
      SELECT 1 FROM spaces.item_assignees ia
      WHERE ia.item_id = i.id
    )`;
  } else if (assignedTo === "me" && currentUserId) {
    conditions = sql`${conditions} AND EXISTS (
      SELECT 1 FROM spaces.item_assignees ia
      WHERE ia.item_id = i.id AND ia.user_id = ${currentUserId}
    )`;
  } else if (assignedTo === "unassigned") {
    conditions = sql`${conditions} AND NOT EXISTS (
      SELECT 1 FROM spaces.item_assignees ia
      WHERE ia.item_id = i.id
    )`;
  }

  // Search filter (search in title and description)
  if (search && search.trim()) {
    const searchPattern = `%${search.trim()}%`;
    conditions = sql`${conditions} AND (i.title ILIKE ${searchPattern} OR i.description ILIKE ${searchPattern} OR i.location ILIKE ${searchPattern} OR i.url ILIKE ${searchPattern})`;
  }

  // Build ORDER BY clause as SQL fragment
  let orderClause = sql`c.rank ASC, i.rank ASC, i.id ASC`;
  switch (sort) {
    case "priority":
      // Custom order: urgent > high > medium > low > null
      orderClause = sortDesc
        ? sql`CASE i.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END DESC, i.rank ASC, i.id ASC`
        : sql`CASE i.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END ASC, i.rank ASC, i.id ASC`;
      break;
    case "deadline":
      orderClause = sortDesc
        ? sql`CASE WHEN i.starts_at IS NOT NULL AND i.ends_at IS NOT NULL THEN i.starts_at ELSE i.deadline END DESC NULLS FIRST, i.rank ASC, i.id ASC`
        : sql`CASE WHEN i.starts_at IS NOT NULL AND i.ends_at IS NOT NULL THEN i.starts_at ELSE i.deadline END ASC NULLS LAST, i.rank ASC, i.id ASC`;
      break;
    case "created":
      orderClause = sortDesc ? sql`i.created_at DESC, i.id ASC` : sql`i.created_at ASC, i.id ASC`;
      break;
    case "updated":
      orderClause = sortDesc ? sql`i.updated_at DESC, i.id ASC` : sql`i.updated_at ASC, i.id ASC`;
      break;
    case "title":
      orderClause = sortDesc ? sql`i.title DESC, i.id ASC` : sql`i.title ASC, i.id ASC`;
      break;
    case "column":
      break;
  }

  // Get total count
  const [countResult] = await sql<{ count: string }[]>`
    SELECT COUNT(*) as count
    FROM spaces.items i
    WHERE ${conditions}
  `;
  const total = parseInt(countResult?.count ?? "0", 10);

  // Calculate pagination
  const totalPages = Math.ceil(total / pageSize);
  const offset = (page - 1) * pageSize;

  // Get items with pagination
  const rows = await sql<DbItem[]>`
    SELECT i.id, i.space_id, i.column_id, i.title, i.description, i.location, i.url, i.starts_at, i.ends_at,
           i.all_day, i.deadline, i.estimated_duration_minutes, i.priority, i.recurrence_rrule, i.recurrence_dtstart, i.recurrence_exdate, i.recurring_event_id, i.recurrence_id,
           i.rank::text AS rank,
           i.completed_at,
           i.created_by, i.created_at, i.updated_at
    FROM spaces.items i
    LEFT JOIN spaces.columns c ON i.column_id = c.id
    WHERE ${conditions}
    ORDER BY ${orderClause}
    LIMIT ${pageSize} OFFSET ${offset}
  `;

  const items = await hydrateRelations(rows.map(mapToItem));

  return {
    items,
    total,
    page,
    pageSize,
    totalPages,
  };
};

/**
 * Cross-space item search for the global search dialog.
 *
 * Single SQL query joining items to their parent space, scoped by the same
 * permission predicate the space list uses. Replaces the per-space
 * `listFiltered` fan-out the capabilities layer used to do, which hit one
 * query per user-visible space. Skips `hydrateRelations` since the dialog
 * doesn't render assignees/tags.
 *
 * `kinds`:
 *   - "task"  → items without a starts_at/ends_at pair
 *   - "event" → items with both starts_at and ends_at
 *   - "all"   → both
 */
export type ItemAcrossKind = "task" | "event" | "all";

export type ItemAcrossResult = {
  item: SpaceItem;
  space: { id: string; name: string };
};

type DbItemAcross = DbItem & {
  space_name: string;
};

const mapCalendarRow = (r: DbCalendarItem, tags: SpaceTag[] = []): CalendarItem => ({
  id: r.id,
  spaceId: r.space_id,
  spaceName: r.space_name,
  spaceColor: r.space_color,
  title: r.title,
  descriptionPreview: descriptionPreview(r.description),
  location: r.location,
  url: r.url,
  startsAt: r.starts_at?.toISOString() ?? null,
  endsAt: r.ends_at?.toISOString() ?? null,
  allDay: r.all_day,
  deadline: r.deadline?.toISOString() ?? null,
  priority: (r.priority as Priority) ?? null,
  recurrence: mapRecurrence(r),
  recurringEventId: r.recurring_event_id,
  recurrenceId: r.recurrence_id?.toISOString() ?? null,
  tags,
});

const calendarRowToRecurringEvent = (item: CalendarItem): (RecurringEvent & { calendarItem: CalendarItem }) | null => {
  if (!item.startsAt || !item.endsAt || !item.recurrence) return null;
  return {
    id: item.id,
    title: item.title,
    start: item.startsAt,
    end: item.endsAt,
    allDay: item.allDay,
    recurrence: {
      rrule: item.recurrence.rrule,
      dtstart: item.recurrence.dtstart ?? item.startsAt,
      exdate: item.recurrence.exdate,
    },
    calendarItem: item,
  };
};

const calendarRowToRecurringOverride = (item: CalendarItem): (RecurringOverride & { calendarItem: CalendarItem }) | null => {
  if (!item.startsAt || !item.endsAt || !item.recurringEventId || !item.recurrenceId) return null;
  return {
    id: item.id,
    title: item.title,
    start: item.startsAt,
    end: item.endsAt,
    allDay: item.allDay,
    recurringEventId: item.recurringEventId,
    recurrenceId: item.recurrenceId,
    calendarItem: item,
  };
};

const expandedToCalendarItem = (event: ExpandedRecurringEvent & { calendarItem?: CalendarItem }): CalendarItem => {
  const source = event.calendarItem;
  if (!source) {
    const parent = event.recurringInstance?.recurringEventId ?? event.id;
    return {
      id: event.id,
      spaceId: "",
      spaceName: "",
      spaceColor: "#3b82f6",
      title: event.title,
      descriptionPreview: null,
      location: null,
      url: null,
      startsAt: new Date(event.start).toISOString(),
      endsAt: event.end ? new Date(event.end).toISOString() : null,
      allDay: event.allDay ?? false,
      deadline: null,
      priority: null,
      recurrence: null,
      recurringEventId: parent,
      recurrenceId: event.recurringInstance?.recurrenceId ?? null,
      isRecurringInstance: !!event.recurringInstance,
      tags: [],
    };
  }

  return {
    ...source,
    id: event.id,
    startsAt: new Date(event.start).toISOString(),
    endsAt: event.end ? new Date(event.end).toISOString() : null,
    recurringEventId: event.recurringInstance?.recurringEventId ?? source.recurringEventId,
    recurrenceId: event.recurringInstance?.recurrenceId ?? source.recurrenceId,
    isRecurringInstance: !!event.recurringInstance,
  };
};

export const searchAcross = async (params: {
  subject: AccessSubject;
  boundSpaceId?: string | null;
  query: string;
  kinds: ItemAcrossKind;
  status?: "open";
  priority?: Priority[];
  requiredLevel?: "read" | "write";
  limit: number;
}): Promise<ItemAcrossResult[]> => {
  const { query, kinds, limit } = params;
  if (params.subject.type === "service_account" && !isSpaceResourceId(params.boundSpaceId)) return [];
  const principalMatch = buildSpacePrincipalCondition(params.subject);
  const bindingMatch = params.subject.type === "service_account" ? sql`s.id = ${params.boundSpaceId}::uuid` : sql`true`;
  const trimmed = query.trim();
  // Empty query is valid — used by tag-only searches like `#task` or `#event`.
  // Pattern becomes `%%` which ILIKE-matches every row; the title-match
  // ranking CASE collapses to a constant so results sort by `updated_at DESC`.
  const pattern = `%${trimmed}%`;

  let kindCondition = sql`TRUE`;
  if (kinds === "task") {
    kindCondition = sql`(i.starts_at IS NULL OR i.ends_at IS NULL)`;
  } else if (kinds === "event") {
    kindCondition = sql`(i.starts_at IS NOT NULL AND i.ends_at IS NOT NULL)`;
  }

  const statusCondition = params.status === "open" ? sql`i.completed_at IS NULL` : sql`TRUE`;
  const priorityCondition =
    params.priority && params.priority.length > 0 ? sql`i.priority = ANY(${toPgTextArray(params.priority)}::text[])` : sql`TRUE`;
  const permissionCondition = params.requiredLevel === "write" ? sql`a.permission IN ('write', 'admin')` : sql`a.permission <> 'none'`;

  // Permission check via EXISTS subquery rather than LEFT JOIN. The previous
  // join approach needed `SELECT DISTINCT` to dedupe items joined to multiple
  // ACL rows, but `DISTINCT` combined with `ORDER BY CASE WHEN i.title ILIKE
  // pattern THEN 0 ELSE 1 END` is illegal in Postgres (the CASE expression
  // isn't in the distinct projection). The EXISTS form has neither problem
  // and is what notebooks.searchAcross uses.
  const rows = await sql<DbItemAcross[]>`
    SELECT
      i.id, i.space_id, i.column_id, i.title, i.description, i.location, i.url, i.starts_at, i.ends_at,
      i.all_day, i.deadline, i.estimated_duration_minutes, i.priority, i.recurrence_rrule, i.recurrence_dtstart, i.recurrence_exdate, i.recurring_event_id, i.recurrence_id,
      i.rank::text AS rank,
      i.completed_at,
      i.created_by, i.created_at, i.updated_at,
      s.name AS space_name
    FROM spaces.items i
    JOIN spaces.spaces s ON s.id = i.space_id
    WHERE EXISTS (
      SELECT 1
      FROM spaces.space_access sa
      JOIN auth.access a ON a.id = sa.access_id
      WHERE sa.space_id = s.id
        AND ${permissionCondition}
        AND ${principalMatch}
        AND ${bindingMatch}
    )
      AND ${kindCondition}
      AND ${statusCondition}
      AND ${priorityCondition}
      AND (i.title ILIKE ${pattern} OR i.description ILIKE ${pattern} OR i.location ILIKE ${pattern} OR i.url ILIKE ${pattern})
    ORDER BY
      CASE WHEN i.title ILIKE ${pattern} THEN 0 ELSE 1 END,
      i.updated_at DESC
    LIMIT ${limit}
  `;

  const items = rows.map(mapToItem);
  const blockerCountsByItemId = await getActiveBlockerCountsByItemIds(items.map((item) => item.id));
  return rows.map((row, index) => ({
    item: { ...items[index]!, activeBlockerCount: blockerCountsByItemId.get(row.id) ?? 0 },
    space: { id: row.space_id, name: row.space_name },
  }));
};

/**
 * Get an item by ID with relations
 */
export const get = async (params: { id: string }): Promise<SpaceItem | null> => {
  const [row] = await sql<DbItem[]>`
    SELECT
      i.id,
      i.space_id,
      i.column_id,
      i.title,
      i.description,
      i.location,
      i.url,
      i.starts_at,
      i.ends_at,
      i.all_day,
      i.deadline,
      i.estimated_duration_minutes,
      i.priority,
      i.recurrence_rrule,
      i.recurrence_dtstart,
      i.recurrence_exdate,
      i.recurring_event_id,
      i.recurrence_id,
      i.rank::text AS rank,
      i.completed_at,
      i.created_by,
      i.created_at,
      i.updated_at
    FROM spaces.items i
    WHERE i.id = ${params.id}
  `;

  if (!row) return null;

  const item = mapToItem(row);
  const [assignees, tags, blockerCounts] = await Promise.all([
    getAssignees(item.id),
    getTags(item.id),
    getActiveBlockerCountsByItemIds([item.id]),
  ]);
  item.assignees = assignees;
  item.tags = tags;
  item.activeBlockerCount = blockerCounts.get(item.id) ?? 0;

  return item;
};

export const getRecurringOverride = async (params: { recurringEventId: string; recurrenceId: string }): Promise<SpaceItem | null> => {
  const [row] = await sql<{ id: string }[]>`
    SELECT id
    FROM spaces.items
    WHERE recurring_event_id = ${params.recurringEventId}
      AND recurrence_id = ${params.recurrenceId}::timestamptz
  `;
  return row ? get({ id: row.id }) : null;
};

/**
 * Create a new item
 */
export const create = async (params: {
  spaceId: string;
  data: CreateItem;
  createdBy: string | null;
  dateConfig?: DateContext;
  actor?: SpaceActivityIdentity;
  idempotency?: {
    actorKey: string;
    actionId: string;
    idempotencyKeyHash: string;
    requestHash: string;
    onReplay?: () => void;
  };
}): Promise<MutationResult<SpaceItem>> => {
  const { spaceId, data, createdBy } = params;

  // Verify column belongs to space
  const [column] = await sql<{ id: string }[]>`
    SELECT id FROM spaces.columns
    WHERE id = ${data.columnId} AND space_id = ${spaceId}
  `;

  if (!column) {
    return { ok: false, error: "Column not found in space", status: 400 };
  }

  const recurrenceCheck = await validateRecurrenceInput({
    spaceId,
    startsAt: data.startsAt,
    endsAt: data.endsAt,
    recurrence: data.recurrence,
    recurringEventId: data.recurringEventId,
    recurrenceId: data.recurrenceId,
    dateConfig: params.dateConfig,
  });
  if (!recurrenceCheck.ok) return recurrenceCheck;
  if (data.estimatedDurationMinutes !== undefined && (data.startsAt || data.endsAt)) {
    return { ok: false, error: "Estimated duration is only available for tasks", status: 400 };
  }
  const tagCheck = await validateTagIdsInSpace(spaceId, data.tagIds);
  if (!tagCheck.ok) return tagCheck;
  const assigneeCheck = await validateAssigneeIdsInSpace(spaceId, data.assigneeIds);
  if (!assigneeCheck.ok) return assigneeCheck;

  // Get next rank in column
  const [maxRow] = await sql<{ max: string | null }[]>`
    SELECT MAX(rank)::text as max
    FROM spaces.items
    WHERE column_id = ${data.columnId}
  `;
  const nextRank = rank.next(maxRow?.max);
  const recurrence = recurrenceValues(data.recurrence);

  const row = await withShortId("item", (shortId) =>
    sql.begin(async (tx): Promise<{ id: string; replayed: boolean; conflict?: boolean } | null> => {
      let allocatedId: string | null = null;
      if (params.idempotency) {
        const [allocated] = await tx<{ id: string }[]>`SELECT gen_random_uuid() AS id`;
        if (!allocated) throw new Error("Failed to allocate Space item id");
        const [claim] = await tx<{ item_id: string }[]>`
          INSERT INTO spaces.capability_action_results (
            actor_key, action_id, idempotency_key_hash, request_hash, item_id
          ) VALUES (
            ${params.idempotency.actorKey}, ${params.idempotency.actionId},
            ${params.idempotency.idempotencyKeyHash}, ${params.idempotency.requestHash}, ${allocated.id}::uuid
          )
          ON CONFLICT (actor_key, action_id, idempotency_key_hash) DO NOTHING
          RETURNING item_id
        `;
        if (!claim) {
          const [existing] = await tx<{ request_hash: string; item_id: string }[]>`
            SELECT request_hash, item_id
            FROM spaces.capability_action_results
            WHERE actor_key = ${params.idempotency.actorKey}
              AND action_id = ${params.idempotency.actionId}
              AND idempotency_key_hash = ${params.idempotency.idempotencyKeyHash}
          `;
          if (!existing) throw new Error("Space idempotency replay lookup failed");
          if (existing.request_hash !== params.idempotency.requestHash) {
            return { id: existing.item_id, replayed: true, conflict: true };
          }
          return { id: existing.item_id, replayed: true };
        }
        allocatedId = claim.item_id;
      }
      const [created] = await tx<{ id: string }[]>`
      INSERT INTO spaces.items (
        id, short_id, space_id, column_id, title, description, location, url, starts_at, ends_at, deadline,
        estimated_duration_minutes, all_day, priority, recurrence_rrule, recurrence_dtstart, recurrence_exdate,
        recurring_event_id, recurrence_id, rank, completed_at, created_by
      )
      VALUES (
        COALESCE(${allocatedId}::uuid, gen_random_uuid()), ${shortId},
        ${spaceId},
        ${data.columnId},
        ${data.title},
        ${data.description ?? null},
        ${data.location ?? null},
        ${data.url ?? null},
        ${data.startsAt ?? null},
        ${data.endsAt ?? null},
        ${data.deadline ?? null},
        ${data.estimatedDurationMinutes ?? null},
        ${data.allDay ?? false},
        ${data.priority ?? null},
        ${recurrence.rrule},
        ${recurrence.dtstart},
        ${recurrence.exdate ? sql`${recurrence.exdate}::timestamptz[]` : null},
        ${data.recurringEventId ?? null},
        ${data.recurrenceId ?? null},
        ${rank.toDb(nextRank)}::bigint,
        ${null},
        ${createdBy}::uuid
      )
      ON CONFLICT (recurring_event_id, recurrence_id)
      WHERE recurring_event_id IS NOT NULL AND recurrence_id IS NOT NULL
      DO NOTHING
      RETURNING id
    `;

      if (!created) return null;

      if (data.assigneeIds !== undefined) {
        await replaceItemAssignees(tx, created.id, data.assigneeIds);
      }

      if (data.tagIds !== undefined) {
        await replaceItemTags(tx, created.id, data.tagIds);
      }

      if (data.references?.length) {
        await insertItemResourceReferences(tx, created.id, data.references);
      }

      await activity.record(
        {
          spaceId,
          itemId: created.id,
          actor: params.actor ?? (createdBy ? { kind: "user", id: createdBy } : systemActor),
          action: data.startsAt && data.endsAt ? "event.created" : "task.created",
          metadata: { itemTitle: data.title },
        },
        tx,
      );

      return { id: created.id, replayed: false };
    }),
  );

  if (!row) {
    if (data.recurringEventId && data.recurrenceId) {
      return { ok: false, error: "This occurrence already has a stored override", status: 409 };
    }
    return { ok: false, error: "Failed to create item", status: 500 };
  }
  if (row.conflict) return { ok: false, error: "Idempotency-Key was already used with different input", status: 409 };

  const item = await get({ id: row.id });
  if (!item) {
    return { ok: false, error: "Failed to load created item", status: 500 };
  }

  if (row.replayed) params.idempotency?.onReplay?.();
  else {
    await publishSpaceEvent({ type: "item.created", spaceId, itemId: item.id });
  }
  return { ok: true, data: item };
};

/**
 * Update an item
 */
export const update = async (params: {
  id: string;
  data: UpdateItem;
  dateConfig?: DateContext;
  actor?: SpaceActivityIdentity;
}): Promise<MutationResult<SpaceItem>> => {
  const { id, data } = params;

  const existing = await get({ id });
  if (!existing) {
    return { ok: false, error: "Item not found", status: 404 };
  }
  const tagCheck = await validateTagIdsInSpace(existing.spaceId, data.tagIds);
  if (!tagCheck.ok) return tagCheck;
  const assigneeCheck = await validateAssigneeIdsInSpace(existing.spaceId, data.assigneeIds);
  if (!assigneeCheck.ok) return assigneeCheck;

  const result = await sql.begin(async (tx): Promise<MutationResult<{ id: string }>> => {
    const [locked] = await tx<DbItem[]>`
      SELECT id, space_id, column_id, title, description, location, url, starts_at, ends_at, all_day, deadline,
        estimated_duration_minutes, priority, recurrence_rrule, recurrence_dtstart, recurrence_exdate,
        recurring_event_id, recurrence_id, rank::text AS rank, completed_at, created_by, created_at, updated_at
      FROM spaces.items
      WHERE id = ${id}
      FOR UPDATE
    `;
    if (!locked) return { ok: false, error: "Item not found", status: 404 };

    const current = mapToItem(locked);
    const columnId = data.columnId ?? current.columnId;
    const title = data.title ?? current.title;
    const description = data.description === undefined ? current.description : data.description;
    const location = data.location === undefined ? current.location : data.location;
    const url = data.url === undefined ? current.url : data.url;
    const startsAt = data.startsAt === undefined ? current.startsAt : data.startsAt;
    const endsAt = data.endsAt === undefined ? current.endsAt : data.endsAt;
    const allDay = data.allDay === undefined ? current.allDay : data.allDay;
    const deadline = data.deadline === undefined ? current.deadline : data.deadline;
    const estimatedDurationMinutes =
      data.estimatedDurationMinutes === undefined ? current.estimatedDurationMinutes : data.estimatedDurationMinutes;
    const priority = data.priority === undefined ? current.priority : data.priority;
    let recurrence = data.recurrence === undefined ? current.recurrence : data.recurrence;
    const recurringEventId = data.recurringEventId === undefined ? current.recurringEventId : data.recurringEventId;
    const recurrenceId = data.recurrenceId === undefined ? current.recurrenceId : data.recurrenceId;
    const changingColumn = columnId !== current.columnId;
    const seriesShiftMilliseconds =
      current.recurrence && recurrence && !current.recurringEventId && current.startsAt && startsAt
        ? new Date(startsAt).getTime() - new Date(current.startsAt).getTime()
        : 0;
    if (seriesShiftMilliseconds !== 0 && recurrence && data.recurrence === undefined) {
      recurrence = {
        ...recurrence,
        rrule: shiftRecurrenceRule(recurrence.rrule, seriesShiftMilliseconds),
        dtstart: startsAt,
        exdate: recurrence.exdate.map((value) => shiftIsoInstant(value, seriesShiftMilliseconds)),
      };
    }
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
      return { ok: false, error: "End time must be after start time", status: 400 };
    }
    if (estimatedDurationMinutes !== null && (startsAt || endsAt)) {
      return { ok: false, error: "Estimated duration is only available for tasks", status: 400 };
    }

    let targetRank: bigint | null = null;
    if (changingColumn) {
      const [newColumn] = await tx<{ space_id: string }[]>`
        SELECT space_id FROM spaces.columns WHERE id = ${columnId}
      `;
      if (!newColumn || newColumn.space_id !== current.spaceId) {
        return { ok: false, error: "Column not found in space", status: 400 };
      }
      const [minRow] = await tx<{ min: string | null }[]>`
        SELECT MIN(rank)::text AS min FROM spaces.items WHERE column_id = ${columnId} AND id <> ${id}
      `;
      const minRank = minRow?.min ? rank.parse(minRow.min) : null;
      targetRank = minRank !== null ? minRank - rank.step() : rank.step();
    }
    const recurrenceCheck = await validateRecurrenceInput(
      {
        spaceId: current.spaceId,
        startsAt,
        endsAt,
        recurrence,
        recurringEventId,
        recurrenceId,
        dateConfig: params.dateConfig,
      },
      tx,
    );
    if (!recurrenceCheck.ok) return recurrenceCheck;
    const recurrenceDb = recurrenceValues(recurrence);
    const [updated] = changingColumn
      ? await tx<{ id: string }[]>`
          UPDATE spaces.items
          SET column_id = ${columnId},
              rank = ${rank.toDb(targetRank ?? rank.step())}::bigint,
              title = ${title},
              description = ${description},
              location = ${location},
              url = ${url},
              starts_at = ${startsAt},
              ends_at = ${endsAt},
              all_day = ${allDay},
              deadline = ${deadline},
              estimated_duration_minutes = ${estimatedDurationMinutes},
              priority = ${priority},
              recurrence_rrule = ${recurrenceDb.rrule},
              recurrence_dtstart = ${recurrenceDb.dtstart},
              recurrence_exdate = ${recurrenceDb.exdate ? sql`${recurrenceDb.exdate}::timestamptz[]` : null},
              recurring_event_id = ${recurringEventId},
              recurrence_id = ${recurrenceId},
              updated_at = now()
          WHERE id = ${id}
          RETURNING id
        `
      : await tx<{ id: string }[]>`
          UPDATE spaces.items
          SET title = ${title},
              description = ${description},
              location = ${location},
              url = ${url},
              starts_at = ${startsAt},
              ends_at = ${endsAt},
              all_day = ${allDay},
              deadline = ${deadline},
              estimated_duration_minutes = ${estimatedDurationMinutes},
              priority = ${priority},
              recurrence_rrule = ${recurrenceDb.rrule},
              recurrence_dtstart = ${recurrenceDb.dtstart},
              recurrence_exdate = ${recurrenceDb.exdate ? sql`${recurrenceDb.exdate}::timestamptz[]` : null},
              recurring_event_id = ${recurringEventId},
              recurrence_id = ${recurrenceId},
              updated_at = now()
          WHERE id = ${id}
          RETURNING id
        `;

    if (!updated) return { ok: false, error: "Item not found", status: 404 };

    if (data.assigneeIds !== undefined) {
      await replaceItemAssignees(tx, id, data.assigneeIds);
    }

    if (data.tagIds !== undefined) {
      await replaceItemTags(tx, id, data.tagIds);
    }
    if (seriesShiftMilliseconds !== 0) {
      const interval = sql`(${seriesShiftMilliseconds}::double precision * interval '1 millisecond')`;
      await tx`
        UPDATE spaces.items
        SET recurrence_id = recurrence_id + ${interval},
            starts_at = starts_at + ${interval},
            ends_at = ends_at + ${interval},
            updated_at = now()
        WHERE recurring_event_id = ${id}
          AND recurrence_id IS NOT NULL
      `;
      await tx`
        UPDATE spaces.comments
        SET recurrence_id = recurrence_id + ${interval}
        WHERE item_id = ${id}
          AND recurrence_id IS NOT NULL
      `;
    }

    await activity.record(
      {
        spaceId: current.spaceId,
        itemId: id,
        actor: params.actor ?? systemActor,
        action: startsAt && endsAt ? "event.updated" : "task.updated",
        metadata: { itemTitle: title },
        bucketStartedAt: hourBucket(),
      },
      tx,
    );
    return { ok: true, data: updated };
  });
  if (!result.ok) return result;

  const item = await get({ id: result.data.id });
  if (!item) {
    return { ok: false, error: "Failed to load updated item", status: 500 };
  }

  await publishSpaceEvent({ type: "item.updated", spaceId: item.spaceId, itemId: item.id });
  return { ok: true, data: item };
};

/**
 * Splits a recurring series and transfers all future occurrence-owned data in
 * one transaction. This prevents partially split series when any write fails.
 */
export const splitRecurring = async (params: {
  id: string;
  data: SplitRecurringItem;
  createdBy: string | null;
  dateConfig?: DateContext;
}): Promise<MutationResult<SpaceItem>> => {
  const result = await withShortId("item", (shortId) =>
    sql.begin(async (tx): Promise<MutationResult<{ id: string; spaceId: string; created: boolean }>> => {
      const [source] = await tx<DbItem[]>`
      SELECT
        id, space_id, column_id, title, description, location, url, starts_at, ends_at, all_day, deadline, estimated_duration_minutes, priority,
        recurrence_rrule, recurrence_dtstart, recurrence_exdate, recurring_event_id, recurrence_id, rank::text AS rank,
        completed_at, created_by, created_at, updated_at
      FROM spaces.items
      WHERE id = ${params.id}
      FOR UPDATE
    `;
      if (!source) return { ok: false, error: "Item not found", status: 404 };
      if (!source.starts_at || !source.ends_at || !source.recurrence_rrule || source.recurring_event_id) {
        return { ok: false, error: "Item is not a recurring series", status: 400 };
      }

      const split = splitRecurringEvent({
        event: {
          id: source.id,
          title: source.title,
          start: source.starts_at,
          end: source.ends_at,
          allDay: source.all_day,
          recurrence: {
            rrule: source.recurrence_rrule,
            dtstart: source.recurrence_dtstart ?? source.starts_at,
            exdate: source.recurrence_exdate ?? [],
          },
        },
        recurrenceId: params.data.recurrenceId,
        nextStart: params.data.startsAt,
        dateConfig: params.dateConfig,
      });
      if (!split) return { ok: false, error: "Recurring occurrence not found", status: 404 };

      const recurrenceId = new Date(params.data.recurrenceId).toISOString();
      const shiftMilliseconds = new Date(params.data.startsAt).getTime() - new Date(recurrenceId).getTime();
      const interval = sql`(${shiftMilliseconds}::double precision * interval '1 millisecond')`;
      const previousExdate = split.previousExdate.length > 0 ? toPgTimestampArray(split.previousExdate) : null;
      const nextExdate = split.nextExdate.length > 0 ? toPgTimestampArray(split.nextExdate) : null;

      if (split.isFirstOccurrence) {
        await tx`
        UPDATE spaces.items
        SET starts_at = ${params.data.startsAt}::timestamptz,
            ends_at = ${params.data.endsAt}::timestamptz,
            all_day = ${params.data.allDay},
            recurrence_rrule = ${split.nextRrule},
            recurrence_dtstart = ${params.data.startsAt}::timestamptz,
            recurrence_exdate = ${nextExdate ? sql`${nextExdate}::timestamptz[]` : null},
            updated_at = now()
        WHERE id = ${source.id}
      `;
        await tx`
        UPDATE spaces.items
        SET recurrence_id = recurrence_id + ${interval},
            starts_at = starts_at + ${interval},
            ends_at = ends_at + ${interval},
            updated_at = now()
        WHERE recurring_event_id = ${source.id}
          AND recurrence_id IS NOT NULL
      `;
        await tx`
        UPDATE spaces.comments
        SET recurrence_id = recurrence_id + ${interval}
        WHERE item_id = ${source.id}
          AND recurrence_id IS NOT NULL
      `;
        return { ok: true, data: { id: source.id, spaceId: source.space_id, created: false } };
      }

      await tx`
      UPDATE spaces.items
      SET recurrence_rrule = ${split.previousRrule},
          recurrence_exdate = ${previousExdate ? sql`${previousExdate}::timestamptz[]` : null},
          updated_at = now()
      WHERE id = ${source.id}
    `;

      const [created] = await tx<{ id: string }[]>`
      INSERT INTO spaces.items (
        short_id, space_id, column_id, title, description, location, url, starts_at, ends_at, all_day, deadline, estimated_duration_minutes, priority,
        recurrence_rrule, recurrence_dtstart, recurrence_exdate, recurring_event_id, recurrence_id, rank,
        completed_at, created_by
      )
      SELECT
        ${shortId},
        space_id,
        column_id,
        title,
        description,
        location,
        url,
        ${params.data.startsAt}::timestamptz,
        ${params.data.endsAt}::timestamptz,
        ${params.data.allDay},
        deadline,
        estimated_duration_minutes,
        priority,
        ${split.nextRrule},
        ${params.data.startsAt}::timestamptz,
        ${nextExdate ? sql`${nextExdate}::timestamptz[]` : null},
        NULL,
        NULL,
        COALESCE((SELECT MAX(rank) + ${rank.step()} FROM spaces.items WHERE column_id = ${source.column_id}), ${rank.step()}),
        NULL,
        ${params.createdBy}::uuid
      FROM spaces.items
      WHERE id = ${source.id}
      RETURNING id
    `;
      if (!created) return { ok: false, error: "Failed to create split series", status: 500 };

      await tx`
      INSERT INTO spaces.item_assignees (item_id, user_id)
      SELECT ${created.id}, user_id
      FROM spaces.item_assignees
      WHERE item_id = ${source.id}
      ON CONFLICT DO NOTHING
    `;
      await tx`
      INSERT INTO spaces.item_tags (item_id, tag_id)
      SELECT ${created.id}, tag_id
      FROM spaces.item_tags
      WHERE item_id = ${source.id}
      ON CONFLICT DO NOTHING
    `;
      await tx`
      INSERT INTO spaces.item_resource_refs (item_id, resource_type, resource_id, label, created_at)
      SELECT ${created.id}, resource_type, resource_id, label, created_at
      FROM spaces.item_resource_refs
      WHERE item_id = ${source.id}
      ON CONFLICT DO NOTHING
    `;
      await tx`
      UPDATE spaces.items
      SET recurring_event_id = ${created.id},
          recurrence_id = recurrence_id + ${interval},
          starts_at = starts_at + ${interval},
          ends_at = ends_at + ${interval},
          updated_at = now()
      WHERE recurring_event_id = ${source.id}
        AND recurrence_id >= ${recurrenceId}::timestamptz
    `;
      await tx`
      UPDATE spaces.comments
      SET item_id = ${created.id},
          recurrence_id = recurrence_id + ${interval}
      WHERE item_id = ${source.id}
        AND recurrence_id >= ${recurrenceId}::timestamptz
    `;

      return { ok: true, data: { id: created.id, spaceId: source.space_id, created: true } };
    }),
  );
  if (!result.ok) return result;

  const item = await get({ id: result.data.id });
  if (!item) return { ok: false, error: "Failed to load split series", status: 500 };

  await publishSpaceEvent({ type: "item.updated", spaceId: result.data.spaceId, itemId: params.id });
  if (result.data.created) {
    await publishSpaceEvent({ type: "item.created", spaceId: result.data.spaceId, itemId: item.id });
  }
  return { ok: true, data: item };
};

/**
 * Delete an item
 */
export const remove = async (params: { id: string; actor?: SpaceActivityIdentity }): Promise<MutationResult<void>> => {
  const result = await sql.begin(async (tx): Promise<MutationResult<{ shortId: string; spaceId: string }>> => {
    const [existing] = await tx<{ short_id: string; space_id: string; title: string; starts_at: Date | null; ends_at: Date | null }[]>`
      SELECT short_id, space_id, title, starts_at, ends_at FROM spaces.items WHERE id = ${params.id} FOR UPDATE
    `;
    if (!existing) return { ok: false, error: "Item not found", status: 404 };
    await activity.record(
      {
        spaceId: existing.space_id,
        actor: params.actor ?? systemActor,
        action: existing.starts_at && existing.ends_at ? "event.deleted" : "task.deleted",
        metadata: { itemTitle: existing.title },
      },
      tx,
    );
    await tx`DELETE FROM spaces.items WHERE id = ${params.id}`;
    return { ok: true, data: { shortId: existing.short_id, spaceId: existing.space_id } };
  });
  if (!result.ok) return result;
  await publishSpaceEvent(
    { type: "item.deleted", spaceId: result.data.spaceId, itemId: params.id },
    { itemId: result.data.shortId },
  );
  return { ok: true, data: undefined };
};

/**
 * Move an item to a different column/rank
 */
export const move = async (params: {
  id: string;
  columnId: string;
  rank: string;
  completed?: boolean;
  actor?: SpaceActivityIdentity;
}): Promise<MutationResult<SpaceItem>> => {
  const { id, columnId } = params;
  let targetRank: bigint;
  try {
    targetRank = rank.parse(params.rank);
  } catch {
    return { ok: false, error: "Invalid rank", status: 400 };
  }

  const completedAt = typeof params.completed === "boolean" ? (params.completed ? new Date() : null) : undefined;
  const result = await sql.begin(async (tx): Promise<MutationResult<{ id: string }>> => {
    const [existing] = await tx<{ id: string; space_id: string; title: string }[]>`
      SELECT id, space_id, title FROM spaces.items WHERE id = ${id} FOR UPDATE
    `;
    if (!existing) return { ok: false, error: "Item not found", status: 404 };
    const [column] = await tx<{ space_id: string }[]>`SELECT space_id FROM spaces.columns WHERE id = ${columnId}`;
    if (!column || column.space_id !== existing.space_id) {
      return { ok: false, error: "Column not found in space", status: 400 };
    }
    const [row] = completedAt === undefined
      ? await tx<{ id: string }[]>`
          UPDATE spaces.items
          SET column_id = ${columnId},
              rank = ${rank.toDb(targetRank)}::bigint,
              updated_at = now()
          WHERE id = ${id}
          RETURNING id
        `
      : await tx<{ id: string }[]>`
          UPDATE spaces.items
          SET column_id = ${columnId},
              rank = ${rank.toDb(targetRank)}::bigint,
              completed_at = ${completedAt},
              updated_at = now()
          WHERE id = ${id}
          RETURNING id
        `;
    if (!row) return { ok: false, error: "Failed to move item", status: 500 };
    await activity.record(
      {
        spaceId: existing.space_id,
        itemId: id,
        actor: params.actor ?? systemActor,
        action: "item.moved",
        metadata: { itemTitle: existing.title },
        bucketStartedAt: hourBucket(),
      },
      tx,
    );
    return { ok: true, data: row };
  });
  if (!result.ok) return result;

  const item = await get({ id: result.data.id });
  if (!item) {
    return { ok: false, error: "Failed to load moved item", status: 500 };
  }

  await publishSpaceEvent({ type: "item.moved", spaceId: item.spaceId, itemId: item.id });
  return { ok: true, data: item };
};

/**
 * Set completion status of an item
 */
export const setCompleted = async (params: {
  id: string;
  completed: boolean;
  actor?: SpaceActivityIdentity;
}): Promise<MutationResult<SpaceItem>> => {
  const { id, completed } = params;
  const completedAt = completed ? new Date() : null;
  const result = await sql.begin(async (tx): Promise<MutationResult<{ id: string }>> => {
    const [located] = await tx<{ space_id: string }[]>`
      SELECT space_id FROM spaces.items WHERE id = ${id}::uuid
    `;
    if (!located) return { ok: false, error: "Item not found", status: 404 };

    await tx`SELECT pg_advisory_xact_lock(hashtext('spaces.item-dependencies'), hashtext(${located.space_id}))`;
    const [current] = await tx<{ id: string; space_id: string; title: string; starts_at: Date | null; ends_at: Date | null }[]>`
      SELECT id, space_id, title, starts_at, ends_at FROM spaces.items WHERE id = ${id}::uuid FOR UPDATE
    `;
    if (!current) return { ok: false, error: "Item not found", status: 404 };
    if (completed) {
      const [blockers] = await tx<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM spaces.item_dependencies dependency
        JOIN spaces.items blocker ON blocker.id = dependency.blocker_item_id
        WHERE dependency.item_id = ${id}::uuid
          AND blocker.completed_at IS NULL
      `;
      if ((blockers?.count ?? 0) > 0) {
        return { ok: false, error: "Complete all blocking tasks first", status: 409 };
      }
    }

    // Completion and workflow status are one concept: keep items in a column
    // whose `is_done` value matches the requested state. If the current column
    // already matches, preserve it; otherwise use the first matching column and
    // append the item there.
    const [row] = await tx<{ id: string }[]>`
      WITH current_item AS (
        SELECT i.id, i.space_id, i.column_id, c.is_done AS column_is_done
        FROM spaces.items i
        JOIN spaces.columns c ON c.id = i.column_id
        WHERE i.id = ${id}::uuid
      ), target_column AS (
        SELECT COALESCE(
          (SELECT column_id FROM current_item WHERE column_is_done = ${completed}),
          (
            SELECT c.id
            FROM spaces.columns c
            JOIN current_item current ON current.space_id = c.space_id
            WHERE c.is_done = ${completed}
            ORDER BY c.rank ASC
            LIMIT 1
          )
        ) AS id
      ), target_rank AS (
        SELECT COALESCE(MAX(i.rank), 0) + 1024 AS value
        FROM spaces.items i
        JOIN target_column target ON target.id = i.column_id
      )
      UPDATE spaces.items item
      SET completed_at = ${completedAt},
          column_id = COALESCE((SELECT id FROM target_column), item.column_id),
          rank = CASE
            WHEN (SELECT id FROM target_column) IS DISTINCT FROM item.column_id THEN (SELECT value FROM target_rank)
            ELSE item.rank
          END,
          updated_at = now()
      WHERE item.id = ${id}::uuid
      RETURNING item.id
    `;
    if (!row) return { ok: false, error: "Item not found", status: 404 };
    const activityKind = current.starts_at && current.ends_at ? "event" : "task";
    await activity.record(
      {
        spaceId: current.space_id,
        itemId: id,
        actor: params.actor ?? systemActor,
        action: `${activityKind}.${completed ? "completed" : "reopened"}`,
        metadata: { itemTitle: current.title },
      },
      tx,
    );
    return { ok: true, data: row };
  });
  if (!result.ok) return result;

  const item = await get({ id: result.data.id });
  if (!item) {
    return { ok: false, error: "Failed to load item", status: 500 };
  }

  await publishSpaceEvent({ type: "item.completed", spaceId: item.spaceId, itemId: item.id });
  return { ok: true, data: item };
};

/**
 * Set assignees for an item
 */
export const setAssignees = async (params: {
  id: string;
  userIds: string[];
  actor?: SpaceActivityIdentity;
}): Promise<MutationResult<void>> => {
  const { id, userIds } = params;

  // Verify item exists
  const existing = await get({ id });
  if (!existing) {
    return { ok: false, error: "Item not found", status: 404 };
  }

  const assigneeCheck = await validateAssigneeIdsInSpace(existing.spaceId, userIds);
  if (!assigneeCheck.ok) return assigneeCheck;

  const result = await sql.begin(async (tx): Promise<MutationResult<void>> => {
    const [current] = await tx<{ space_id: string; title: string }[]>`
      SELECT space_id, title FROM spaces.items WHERE id = ${id} FOR UPDATE
    `;
    if (!current) return { ok: false, error: "Item not found", status: 404 };
    await replaceItemAssignees(tx, id, userIds);
    await activity.record(
      {
        spaceId: current.space_id,
        itemId: id,
        actor: params.actor ?? systemActor,
        action: "item.assignees.updated",
        metadata: { itemTitle: current.title },
      },
      tx,
    );
    return { ok: true, data: undefined };
  });
  if (!result.ok) return result;

  await publishSpaceEvent({ type: "item.updated", spaceId: existing.spaceId, itemId: existing.id });
  return { ok: true, data: undefined };
};

/**
 * Set tags for an item
 */
export const setTags = async (params: { id: string; tagIds: string[]; actor?: SpaceActivityIdentity }): Promise<MutationResult<void>> => {
  const { id, tagIds } = params;

  // Verify item exists
  const existing = await get({ id });
  if (!existing) {
    return { ok: false, error: "Item not found", status: 404 };
  }
  const tagCheck = await validateTagIdsInSpace(existing.spaceId, tagIds);
  if (!tagCheck.ok) return tagCheck;

  const result = await sql.begin(async (tx): Promise<MutationResult<void>> => {
    const [current] = await tx<{ space_id: string; title: string }[]>`
      SELECT space_id, title FROM spaces.items WHERE id = ${id} FOR UPDATE
    `;
    if (!current) return { ok: false, error: "Item not found", status: 404 };
    await replaceItemTags(tx, id, tagIds);
    await activity.record(
      {
        spaceId: current.space_id,
        itemId: id,
        actor: params.actor ?? systemActor,
        action: "item.tags.updated",
        metadata: { itemTitle: current.title },
      },
      tx,
    );
    return { ok: true, data: undefined };
  });
  if (!result.ok) return result;

  await publishSpaceEvent({ type: "item.updated", spaceId: existing.spaceId, itemId: existing.id });
  return { ok: true, data: undefined };
};

type CalendarAccessParams = {
  subject: AccessSubject;
  boundSpaceId?: string | null;
  spaceId?: string;
  type?: ItemType;
  assignedTo?: AssignedToFilter;
  priorities?: Priority[];
  columnIds?: string[];
  tagIds?: string[];
};

const calendarTypeMatch = (type?: ItemType) => {
  if (type === "task") return sql`(i.starts_at IS NULL OR i.ends_at IS NULL) AND i.deadline IS NOT NULL`;
  if (type === "event") return sql`i.starts_at IS NOT NULL AND i.ends_at IS NOT NULL`;
  return sql`true`;
};

const calendarPriorityMatch = (priorities?: Priority[]) =>
  priorities && priorities.length > 0 ? sql`i.priority = ANY(${toPgTextArray(priorities)}::text[])` : sql`true`;

const calendarColumnMatch = (columnIds?: string[]) =>
  columnIds && columnIds.length > 0 ? sql`i.column_id = ANY(${toPgUuidArray(columnIds)}::uuid[])` : sql`true`;

const calendarTagMatch = (tagIds?: string[]) =>
  tagIds && tagIds.length > 0
    ? sql`EXISTS (
        SELECT 1
        FROM spaces.item_tags it
        WHERE it.item_id = i.id
          AND it.tag_id = ANY(${toPgUuidArray(tagIds)}::uuid[])
      )`
    : sql`true`;

const calendarAssignmentMatch = (assignedTo: AssignedToFilter | undefined, subject: AccessSubject) => {
  if (assignedTo === "assigned") return sql`EXISTS (SELECT 1 FROM spaces.item_assignees ia WHERE ia.item_id = i.id)`;
  if (assignedTo === "unassigned") return sql`NOT EXISTS (SELECT 1 FROM spaces.item_assignees ia WHERE ia.item_id = i.id)`;
  if (assignedTo === "me") {
    return subject.type === "user"
      ? sql`EXISTS (
          SELECT 1 FROM spaces.item_assignees ia
          WHERE ia.item_id = i.id AND ia.user_id = ${subject.userId}::uuid
        )`
      : sql`false`;
  }
  return sql`true`;
};

/**
 * List calendar items across all spaces reachable by the actor.
 * Resource-bound service accounts pass `boundSpaceId` to stay scoped to their bound space.
 */
export const listCalendar = async (
  params: CalendarAccessParams & {
    from: string;
    to: string;
    dateConfig?: DateContext;
  },
): Promise<CalendarItem[]> => {
  const { from, to } = params;
  if (params.subject.type === "service_account" && !isSpaceResourceId(params.boundSpaceId)) return [];
  const principalMatch = buildSpacePrincipalCondition(params.subject);
  const bindingMatch = params.subject.type === "service_account" ? sql`s.id = ${params.boundSpaceId}::uuid` : sql`true`;
  const requestedSpaceMatch = params.spaceId ? sql`s.id = ${params.spaceId}::uuid` : sql`true`;
  const typeMatch = calendarTypeMatch(params.type);
  const priorityMatch = calendarPriorityMatch(params.priorities);
  const columnMatch = calendarColumnMatch(params.columnIds);
  const tagMatch = calendarTagMatch(params.tagIds);
  const assignmentMatch = calendarAssignmentMatch(params.assignedTo, params.subject);

  // Use subquery to get accessible space IDs first, then query items
  const rows = await sql<DbCalendarItem[]>`
    WITH accessible_spaces AS (
      SELECT DISTINCT s.id
      FROM spaces.spaces s
      JOIN spaces.space_access sa ON s.id = sa.space_id
      JOIN auth.access a ON sa.access_id = a.id
      WHERE a.permission <> 'none'
        AND ${principalMatch}
        AND ${bindingMatch}
        AND ${requestedSpaceMatch}
    )
    SELECT i.id, i.space_id, s.name as space_name, s.color as space_color,
           i.title, i.description, i.location, i.url, i.starts_at, i.ends_at, i.all_day, i.deadline, i.priority,
           i.recurrence_rrule, i.recurrence_dtstart, i.recurrence_exdate, i.recurring_event_id, i.recurrence_id
    FROM spaces.items i
    JOIN spaces.spaces s ON i.space_id = s.id
    WHERE i.space_id IN (SELECT id FROM accessible_spaces)
      AND i.completed_at IS NULL
      AND ${typeMatch}
      AND ${priorityMatch}
      AND ${columnMatch}
      AND ${tagMatch}
      AND ${assignmentMatch}
      AND (
        (
          i.recurrence_rrule IS NULL
          AND i.starts_at IS NOT NULL
          AND i.ends_at IS NOT NULL
          AND i.starts_at < ${to}::timestamptz
          AND i.ends_at > ${from}::timestamptz
        )
        OR (
          i.recurrence_rrule IS NOT NULL
          AND i.recurring_event_id IS NULL
          AND i.starts_at IS NOT NULL
          AND i.ends_at IS NOT NULL
        )
        OR (
          i.recurring_event_id IS NOT NULL
          AND i.recurrence_id IS NOT NULL
          AND i.starts_at IS NOT NULL
          AND i.ends_at IS NOT NULL
          AND i.starts_at < ${to}::timestamptz
          AND i.ends_at > ${from}::timestamptz
        )
        OR (i.deadline IS NOT NULL AND i.deadline >= ${from}::timestamptz AND i.deadline < ${to}::timestamptz)
      )
    ORDER BY COALESCE(i.starts_at, i.deadline)
  `;

  const tagsByItemId = await getTagsByItemIds(rows.map((row) => row.id));
  const items = rows.map((row) => mapCalendarRow(row, tagsByItemId.get(row.id) ?? []));
  const recurringEvents = items
    .map(calendarRowToRecurringEvent)
    .filter((event): event is RecurringEvent & { calendarItem: CalendarItem } => !!event);
  const overrides = items
    .map(calendarRowToRecurringOverride)
    .filter((event): event is RecurringOverride & { calendarItem: CalendarItem } => !!event);
  const recurringSourceIds = new Set(recurringEvents.map((event) => event.id));
  const recurringOverrideIds = new Set(overrides.map((event) => event.id));
  const regularItems = items.filter((item) => !recurringSourceIds.has(item.id) && !recurringOverrideIds.has(item.id));
  const overridesBySeries = new Map<string, Array<RecurringOverride & { calendarItem: CalendarItem }>>();
  for (const override of overrides) {
    const siblings = overridesBySeries.get(override.recurringEventId) ?? [];
    siblings.push(override);
    overridesBySeries.set(override.recurringEventId, siblings);
  }
  const expanded = recurringEvents.flatMap((event) => {
    try {
      return expandRecurringEvents({
        events: [event],
        overrides: overridesBySeries.get(event.id) ?? [],
        rangeStart: from,
        rangeEnd: to,
        dateConfig: params.dateConfig,
      }).map((occurrence) => expandedToCalendarItem(occurrence as ExpandedRecurringEvent & { calendarItem?: CalendarItem }));
    } catch (error) {
      log.warn("Skipping invalid recurring calendar series", {
        itemId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  });

  return [...regularItems, ...expanded].sort((a, b) => {
    const aTime = new Date(a.startsAt ?? a.deadline ?? 0).getTime();
    const bTime = new Date(b.startsAt ?? b.deadline ?? 0).getTime();
    return aTime - bTime;
  });
};

/** Task item for widget display */
export type TaskItem = {
  id: string;
  shortId: string;
  spaceId: string;
  spaceShortId: string;
  spaceName: string;
  spaceColor: string;
  title: string;
  deadline: string | null;
  priority: Priority | null;
};

/**
 * List tasks assigned to a specific user (across all spaces they have access to)
 */
export const listMyTasks = async (params: { userId: string; minPriority?: Priority; limit?: number }): Promise<TaskItem[]> => {
  const { userId, minPriority, limit = 20 } = params;
  const principalMatch = buildSpacePrincipalCondition({ type: "user", userId });

  // Build priority filter
  let priorityCondition = sql``;
  if (minPriority) {
    const priorityOrder = { urgent: 1, high: 2, medium: 3, low: 4 };
    const minOrder = priorityOrder[minPriority];
    const allowedPriorities = Object.entries(priorityOrder)
      .filter(([_, order]) => order <= minOrder)
      .map(([p]) => p);
    priorityCondition = sql`AND i.priority = ANY(${toPgTextArray(allowedPriorities)}::text[])`;
  }

  // Use subquery to get accessible space IDs first, then query items
  const rows = await sql<
    {
      id: string;
      short_id: string;
      space_id: string;
      space_short_id: string;
      space_name: string;
      space_color: string;
      title: string;
      deadline: Date | null;
      priority: string | null;
    }[]
  >`
    WITH accessible_spaces AS (
      SELECT DISTINCT s.id
      FROM spaces.spaces s
      JOIN spaces.space_access sa ON s.id = sa.space_id
      JOIN auth.access a ON sa.access_id = a.id
      WHERE a.permission <> 'none'
        AND ${principalMatch}
    )
    SELECT i.id, i.short_id, i.space_id, s.short_id AS space_short_id, s.name as space_name, s.color as space_color,
           i.title, i.deadline, i.priority
    FROM spaces.items i
    JOIN spaces.spaces s ON i.space_id = s.id
    WHERE i.space_id IN (SELECT id FROM accessible_spaces)
      AND i.completed_at IS NULL
      AND (i.starts_at IS NULL OR i.ends_at IS NULL)
      AND EXISTS (
        SELECT 1 FROM spaces.item_assignees ia
        WHERE ia.item_id = i.id AND ia.user_id = ${userId}
      )
      ${priorityCondition}
    ORDER BY
      CASE i.priority
        WHEN 'urgent' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        WHEN 'low' THEN 4
        ELSE 5
      END,
      i.deadline ASC NULLS LAST,
      i.created_at DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    id: r.id,
    shortId: r.short_id,
    spaceId: r.space_id,
    spaceShortId: r.space_short_id,
    spaceName: r.space_name,
    spaceColor: r.space_color,
    title: r.title,
    deadline: r.deadline?.toISOString() ?? null,
    priority: (r.priority as Priority) ?? null,
  }));
};

/**
 * Check for overlapping items across spaces reachable by the actor.
 */
export const checkOverlap = async (
  params: CalendarAccessParams & {
    from: string;
    to: string;
    excludeItemId?: string;
  },
): Promise<OverlapItem[]> => {
  const { from, to, excludeItemId } = params;
  if (params.subject.type === "service_account" && !isSpaceResourceId(params.boundSpaceId)) return [];
  const principalMatch = buildSpacePrincipalCondition(params.subject);
  const bindingMatch = params.subject.type === "service_account" ? sql`i.space_id = ${params.boundSpaceId}::uuid` : sql`true`;

  const rows = await sql<DbOverlapItem[]>`
    SELECT i.id AS item_id, i.space_id, s.name AS space_name, i.title, i.starts_at, i.ends_at
    FROM spaces.items i
    JOIN spaces.spaces s ON s.id = i.space_id
    WHERE i.starts_at IS NOT NULL
      AND i.ends_at IS NOT NULL
      AND i.starts_at < ${to}::timestamptz
      AND i.ends_at > ${from}::timestamptz
      AND (${excludeItemId ?? null}::uuid IS NULL OR i.id <> ${excludeItemId ?? null}::uuid)
      AND ${bindingMatch}
      AND EXISTS (
        SELECT 1
        FROM spaces.space_access sa
        JOIN auth.access a ON a.id = sa.access_id
        WHERE sa.space_id = i.space_id
          AND a.permission <> 'none'
          AND ${principalMatch}
      )
    ORDER BY i.starts_at ASC
  `;

  return rows.map((r) => ({
    itemId: r.item_id,
    spaceId: r.space_id,
    spaceName: r.space_name,
    title: r.title,
    startsAt: r.starts_at.toISOString(),
    endsAt: r.ends_at.toISOString(),
  }));
};
