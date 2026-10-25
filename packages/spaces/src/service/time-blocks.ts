import { type AccessSubject, type RequestActor, userFromActor } from "@k2b/cloud/server";
import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { err, fail, ok, type Paginated, type Result } from "@k2b/stdlib";
import { type SQL, sql } from "bun";
import type { AssignedToFilter, ItemStatus, ItemType, Priority, User } from "../contracts";
import {
  type CreateTimeBlock,
  CreateTimeBlockSchema,
  type SpaceTimeBlock,
  type UpdateTimeBlock,
  UpdateTimeBlockSchema,
} from "../time-block-contracts";
import type { WorkActor } from "../work-contracts";
import {
  buildSpacePrincipalCondition,
  getActorsSpacePermissions,
  permissionFromScopes,
  SPACE_RESOURCE_TYPE,
  SPACES_APP_ID,
} from "./access";
import { publishSpaceChange, spacesLive } from "./live";

export type TimeBlockReader = { actor: RequestActor; subject: AccessSubject };
export const revisionForTimeBlock = (block: SpaceTimeBlock): string =>
  new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        id: block.id,
        itemId: block.itemId,
        ownerId: block.ownerId,
        ownerKind: block.ownerKind,
        title: block.title,
        startsAt: block.startsAt,
        endsAt: block.endsAt,
      }),
    )
    .digest("hex");
export const readerForUser = (user: User): TimeBlockReader => ({
  actor: { kind: "user", user },
  subject: { type: "user", userId: user.id },
});

export const timeBlockOwner = (reader: TimeBlockReader): WorkActor | null => {
  const { actor, subject } = reader;
  if (actor.kind === "service_account" && actor.serviceAccount.kind !== "user_delegated") {
    return subject.type === "service_account" &&
      subject.serviceAccountId === actor.serviceAccount.id &&
      permissionFromScopes(actor.scopes) !== "none"
      ? { kind: "service_account", id: actor.serviceAccount.id }
      : null;
  }
  const user = userFromActor(actor);
  return user && subject.type === "user" && subject.userId === user.id ? { kind: "user", id: user.id } : null;
};
export const mayWriteOwnBlock = (reader: TimeBlockReader) =>
  reader.actor.kind === "user" ||
  reader.actor.serviceAccount.kind === "user_delegated" ||
  ["write", "admin"].includes(permissionFromScopes(reader.actor.scopes));
const owned = (reader: TimeBlockReader) => {
  const owner = timeBlockOwner(reader);
  return owner?.kind === "user"
    ? sql`b.owner_id = ${owner.id}::uuid`
    : owner
      ? sql`b.owner_service_account_id = ${owner.id}::uuid`
      : sql`false`;
};
const assignedToReader = (reader: TimeBlockReader) => {
  const owner = timeBlockOwner(reader);
  return owner?.kind === "user" ? sql`ia.user_id = ${owner.id}::uuid` : owner ? sql`ia.service_account_id = ${owner.id}::uuid` : sql`false`;
};
const isOwner = (row: BlockRow, reader: TimeBlockReader) => {
  const owner = timeBlockOwner(reader);
  return owner !== null && row.owner_id === owner.id && row.owner_kind === owner.kind;
};

/** Same grant, scope and binding rules as getActorsSpacePermissions, expressed in SQL for bounded paging. */
const mayReadSpace = (reader: TimeBlockReader, spaceId: ReturnType<typeof sql.unsafe>) => {
  const actor = reader.actor;
  if (actor.kind === "service_account" && actor.serviceAccount.kind !== "user_delegated") {
    if (permissionFromScopes(actor.scopes) === "none") return sql`false`;
    const account = actor.serviceAccount;
    if (account.kind === "resource_bound") {
      if (account.appId !== SPACES_APP_ID || account.resourceType !== SPACE_RESOURCE_TYPE || !account.resourceId) return sql`false`;
      return sql`${spaceId} = ${account.resourceId}::uuid AND EXISTS (
        SELECT 1 FROM spaces.space_access sa JOIN auth.access a ON a.id = sa.access_id
        WHERE sa.space_id = ${spaceId} AND a.permission IN ('read', 'write', 'admin') AND ${buildSpacePrincipalCondition(reader.subject)}
      )`;
    }
  }
  return sql`EXISTS (SELECT 1 FROM spaces.space_access sa JOIN auth.access a ON a.id = sa.access_id
    WHERE sa.space_id = ${spaceId} AND a.permission IN ('read', 'write', 'admin') AND ${buildSpacePrincipalCondition(reader.subject)})`;
};

type BlockRow = {
  id: string;
  item_id: string | null;
  space_id: string | null;
  owner_id: string;
  owner_kind: WorkActor["kind"];
  title: string;
  starts_at: Date;
  ends_at: Date;
  owner_name: string;
  item_short_id: string | null;
  space_short_id: string | null;
  space_name: string | null;
  space_color: string | null;
  completed_at: Date | null;
  readable: boolean;
  assigned: boolean;
};
// Creation and every Space transfer save b.space_id atomically; keep calendar predicates on its indexed column.
const projection = (reader: TimeBlockReader) => sql`
  b.id, b.item_id, b.space_id, COALESCE(b.owner_id, b.owner_service_account_id) AS owner_id,
  CASE WHEN b.owner_id IS NOT NULL THEN 'user' ELSE 'service_account' END AS owner_kind, b.title, b.starts_at, b.ends_at,
  COALESCE(u.display_name, u.uid, owner_account.name) AS owner_name, i.short_id AS item_short_id, s.short_id AS space_short_id,
  s.name AS space_name, s.color AS space_color, i.completed_at,
  (${mayReadSpace(reader, sql`b.space_id`)}) AS readable,
  EXISTS (SELECT 1 FROM spaces.item_assignees ia WHERE ia.item_id = b.item_id AND (ia.user_id = b.owner_id OR ia.service_account_id = b.owner_service_account_id)) AS assigned
`;
const joins = sql`FROM spaces.time_blocks b
  LEFT JOIN auth.users u ON u.id = b.owner_id
  LEFT JOIN auth.service_accounts owner_account ON owner_account.id = b.owner_service_account_id
  LEFT JOIN spaces.items i ON i.id = b.item_id
  LEFT JOIN spaces.spaces s ON s.id = b.space_id`;
const visible = (reader: TimeBlockReader) => sql`(${mayReadSpace(reader, sql`b.space_id`)} OR ${owned(reader)})`;
const map = (row: BlockRow, reader: TimeBlockReader): SpaceTimeBlock => ({
  id: row.id,
  itemId: row.readable ? row.item_short_id : null,
  spaceId: row.readable ? row.space_short_id : null,
  title: row.title,
  startsAt: row.starts_at.toISOString(),
  endsAt: row.ends_at.toISOString(),
  ownerId: row.owner_id,
  ownerKind: row.owner_kind,
  ownerName: row.owner_name,
  spaceName: row.readable ? row.space_name : null,
  spaceColor: row.readable ? row.space_color : null,
  taskState: !row.item_id ? "deleted" : !row.readable ? "no_access" : row.completed_at ? "done" : "open",
  canWrite: isOwner(row, reader) && mayWriteOwnBlock(reader) && Boolean(row.item_id) && row.readable && row.assigned,
  canDelete: isOwner(row, reader) && mayWriteOwnBlock(reader),
});

const readRow = async (id: string, reader: TimeBlockReader, db: SQL = sql): Promise<BlockRow | undefined> => {
  const [row] = await db<BlockRow[]>`SELECT ${projection(reader)} ${joins} WHERE b.id = ${id}::uuid AND ${visible(reader)}`;
  return row;
};

export const get = async ({ id, reader }: { id: string; reader: TimeBlockReader }): Promise<Result<SpaceTimeBlock>> => {
  if (!CreateTimeBlockSchema.shape.id.safeParse(id).success) return fail(err.badInput("Invalid block ID"));
  const row = await readRow(id, reader);
  return row ? ok(map(row, reader)) : fail(err.notFound("Time block"));
};

const readTask = async (itemId: string, reader: TimeBlockReader, db: SQL = sql, lock = false) => {
  const [task] = await db<
    { id: string; space_id: string; title: string; starts_at: Date | null; ends_at: Date | null; assigned: boolean }[]
  >`
    SELECT i.id, i.space_id, i.title, i.starts_at, i.ends_at,
      EXISTS (SELECT 1 FROM spaces.item_assignees ia WHERE ia.item_id = i.id AND ${assignedToReader(reader)}) AS assigned
    FROM spaces.items i WHERE i.id = ${itemId}::uuid ${lock ? sql`FOR UPDATE OF i` : sql``}`;
  if (!task) return fail(err.notFound("Task"));
  const [permission] = await getActorsSpacePermissions(task.space_id, [reader]);
  if (!permission || permission === "none") return fail(err.forbidden("Task access required"));
  if (task.starts_at || task.ends_at) return fail(err.badInput("Time blocks belong to tasks"));
  return ok(task);
};

export const listForItem = async ({
  itemId,
  reader,
  page,
  perPage,
}: {
  itemId: string;
  reader: TimeBlockReader;
  page?: number;
  perPage?: number;
}): Promise<Result<SpaceTimeBlock[]>> => {
  const task = await readTask(itemId, reader);
  if (!task.ok) return task;
  const currentPage = page ?? 1,
    pageSize = perPage ?? 100;
  if (!Number.isSafeInteger(currentPage) || currentPage < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)
    return fail(err.badInput("Invalid pagination"));
  const explicitPage = page !== undefined || perPage !== undefined;
  const rows = await sql<BlockRow[]>`SELECT ${projection(reader)} ${joins}
    WHERE b.item_id = ${itemId}::uuid AND ${mayReadSpace(reader, sql`b.space_id`)} ORDER BY b.starts_at, b.id
    LIMIT ${explicitPage ? pageSize : pageSize + 1} OFFSET ${(currentPage - 1) * pageSize}`;
  // Preserve the complete-array contract for existing detail callers. Larger tasks opt into the same 100-row
  // pagination as the calendar API; never silently omit blocks or cap how much time a person may plan.
  if (!explicitPage && rows.length > pageSize)
    return fail(err.badInput("More than 100 time blocks; pass page/perPage or use the paginated block list"));
  return ok(rows.map((row) => map(row, reader)));
};

export const list = async (params: {
  reader: TimeBlockReader;
  from?: string;
  to?: string;
  itemId?: string;
  spaceId?: string;
  mine?: boolean;
  page?: number;
  perPage?: number;
  type?: ItemType;
  status?: ItemStatus;
  assignedTo?: AssignedToFilter;
  priorities?: Priority[];
  columnIds?: string[];
  tagIds?: string[];
}): Promise<Result<Paginated<SpaceTimeBlock>>> => {
  const { reader } = params;
  const from = Date.parse(params.from ?? ""),
    to = Date.parse(params.to ?? "");
  const hasRange = params.from !== undefined || params.to !== undefined;
  if (
    (!hasRange && !params.itemId) ||
    (hasRange && (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 366 * 86_400_000))
  )
    return fail(err.badInput("Pass an increasing range of at most 366 days, or an item ID"));
  if (params.itemId) {
    const task = await readTask(params.itemId, reader);
    if (!task.ok) return task;
  }
  const page = params.page ?? 1,
    perPage = params.perPage ?? 100;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100)
    return fail(err.badInput("Invalid pagination"));
  if (params.mine && !timeBlockOwner(reader)) return fail(err.forbidden("My work requires an authenticated owner"));
  if ((params.priorities?.length ?? 0) > 4 || (params.columnIds?.length ?? 0) > 100 || (params.tagIds?.length ?? 0) > 100)
    return fail(err.badInput("Too many task filters"));
  // Hidden task data must not influence filters (including counts) for an owner's no-access block.
  const hasTaskFilters =
    (params.status && params.status !== "all") ||
    (params.assignedTo && params.assignedTo !== "all") ||
    params.priorities?.length ||
    params.columnIds?.length ||
    params.tagIds?.length;
  const assignment =
    params.assignedTo === "me"
      ? sql`EXISTS (SELECT 1 FROM spaces.item_assignees ia WHERE ia.item_id = i.id AND ${assignedToReader(reader)})`
      : params.assignedTo === "assigned"
        ? sql`EXISTS (SELECT 1 FROM spaces.item_assignees ia WHERE ia.item_id = i.id)`
        : params.assignedTo === "unassigned"
          ? sql`NOT EXISTS (SELECT 1 FROM spaces.item_assignees ia WHERE ia.item_id = i.id)`
          : sql`true`;
  const where = sql`${visible(reader)}
    ${hasRange ? sql`AND b.starts_at < ${params.to}::timestamptz AND b.ends_at > ${params.from}::timestamptz` : sql``}
    ${params.itemId ? sql`AND b.item_id = ${params.itemId}::uuid` : sql``}
    ${params.spaceId ? sql`AND b.space_id = ${params.spaceId}::uuid AND ${mayReadSpace(reader, sql`b.space_id`)}` : sql``}
    ${params.mine ? sql`AND ${owned(reader)}` : sql``}
    ${params.type === "event" ? sql`AND false` : sql``}
    AND (b.item_id IS NULL OR (
    ${hasTaskFilters ? sql`${mayReadSpace(reader, sql`b.space_id`)} AND` : sql``}
    ${assignment}
    ${params.status === "active" ? sql`AND i.completed_at IS NULL` : params.status === "completed" ? sql`AND i.completed_at IS NOT NULL` : sql``}
    ${params.priorities?.length ? sql`AND i.priority = ANY(${toPgTextArray(params.priorities)}::text[])` : sql``}
    ${params.columnIds?.length ? sql`AND i.column_id = ANY(${toPgUuidArray(params.columnIds)}::uuid[])` : sql``}
    ${params.tagIds?.length ? sql`AND EXISTS (SELECT 1 FROM spaces.item_tags it WHERE it.item_id = i.id AND it.tag_id = ANY(${toPgUuidArray(params.tagIds)}::uuid[]))` : sql``}
    ))`;
  // Count and page share a snapshot, including an empty page beyond the end.
  return sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const [count] = await tx<{ total: number }[]>`SELECT count(*)::int AS total ${joins} WHERE ${where}`;
    const rows = await tx<BlockRow[]>`SELECT ${projection(reader)} ${joins} WHERE ${where}
      ORDER BY b.starts_at, b.id LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`;
    const total = count?.total ?? 0;
    return ok({ items: rows.map((row) => map(row, reader)), total, page, perPage, hasNext: page * perPage < total });
  });
};

const matchesCreation = async (tx: SQL, itemId: string, owner: WorkActor, data: CreateTimeBlock): Promise<boolean> => {
  const [matching] = await tx`SELECT id FROM spaces.time_blocks WHERE id = ${data.id}::uuid
    AND creation_item_id = ${itemId}::uuid AND creation_owner_id = ${owner.id}::uuid AND creation_owner_kind = ${owner.kind}
    AND creation_starts_at = ${data.startsAt}::timestamptz AND creation_ends_at = ${data.endsAt}::timestamptz`;
  return Boolean(matching);
};

export const create = async ({
  itemId,
  reader,
  data,
  expectedTaskTitle,
}: {
  itemId: string;
  reader: TimeBlockReader;
  data: CreateTimeBlock;
  expectedTaskTitle?: string;
}): Promise<Result<SpaceTimeBlock>> => {
  const parsed = CreateTimeBlockSchema.safeParse(data);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid time block"));
  const owner = timeBlockOwner(reader);
  if (!owner || !mayWriteOwnBlock(reader)) return fail(err.forbidden("Only an assigned owner can plan their time"));
  const result = await sql.begin(async (tx): Promise<Result<SpaceTimeBlock>> => {
    const task = await readTask(itemId, reader, tx, true);
    if (!task.ok) return task;
    if (!task.data.assigned) return fail(err.forbidden("Only an assigned owner can plan their time"));
    if (expectedTaskTitle !== undefined && task.data.title !== expectedTaskTitle && !(await matchesCreation(tx, itemId, owner, data)))
      return fail(err.conflict("Task title changed; review it again"));
    const inserted = await tx`INSERT INTO spaces.time_blocks
      (id, item_id, space_id, owner_id, owner_service_account_id, title, starts_at, ends_at, creation_item_id, creation_owner_id, creation_owner_kind, creation_starts_at, creation_ends_at)
      VALUES (${data.id}::uuid, ${itemId}::uuid, ${task.data.space_id}::uuid, ${owner.kind === "user" ? owner.id : null}::uuid, ${owner.kind === "service_account" ? owner.id : null}::uuid, ${task.data.title},
        ${data.startsAt}::timestamptz, ${data.endsAt}::timestamptz, ${itemId}::uuid, ${owner.id}::uuid, ${owner.kind},
        ${data.startsAt}::timestamptz, ${data.endsAt}::timestamptz) ON CONFLICT (id) DO NOTHING RETURNING id`;
    if (inserted.length === 0) {
      if (!(await matchesCreation(tx, itemId, owner, data))) return fail(err.conflict("Time block ID already used with different input"));
    } else await publishSpaceChange(tx, { type: "item.updated", spaceId: task.data.space_id, itemId });
    const row = await readRow(data.id, reader, tx);
    return row ? ok(map(row, reader)) : fail(err.notFound("Time block"));
  });
  if (result.ok) spacesLive.wake();
  return result;
};

const mutate = async (params: {
  id: string;
  reader: TimeBlockReader;
  data?: UpdateTimeBlock;
  remove?: boolean;
  expectedRevision?: string;
}): Promise<Result<SpaceTimeBlock>> => {
  if (!CreateTimeBlockSchema.shape.id.safeParse(params.id).success) return fail(err.badInput("Invalid block ID"));
  const result = await sql.begin(async (tx): Promise<Result<SpaceTimeBlock>> => {
    // Lock the item before the block, the same order as create and reassignment. Deletion clears the FK.
    const [reference] = await tx<{ item_id: string | null }[]>`SELECT item_id FROM spaces.time_blocks WHERE id = ${params.id}::uuid`;
    if (reference?.item_id) await tx`SELECT id FROM spaces.items WHERE id = ${reference.item_id}::uuid FOR UPDATE`;
    await tx`SELECT id FROM spaces.time_blocks WHERE id = ${params.id}::uuid FOR UPDATE`;
    const row = await readRow(params.id, params.reader, tx);
    if (!row) return fail(err.notFound("Time block"));
    if (!isOwner(row, params.reader) || !mayWriteOwnBlock(params.reader))
      return fail(err.forbidden("Only the assigned owner can change this time block"));
    if (!params.remove && (!row.item_id || !row.readable || !row.assigned))
      return fail(err.forbidden("Task assignment and access required"));
    if (params.expectedRevision !== undefined && revisionForTimeBlock(map(row, params.reader)) !== params.expectedRevision)
      return fail(err.conflict("Time block changed; review it again"));
    if (params.remove) await tx`DELETE FROM spaces.time_blocks WHERE id = ${params.id}::uuid`;
    else {
      const startsAt = params.data?.startsAt ?? row.starts_at.toISOString();
      const endsAt = params.data?.endsAt ?? row.ends_at.toISOString();
      if (Date.parse(endsAt) <= Date.parse(startsAt)) return fail(err.badInput("End time must be after start time"));
      await tx`UPDATE spaces.time_blocks SET title = ${params.data?.title ?? row.title}, starts_at = ${startsAt}::timestamptz,
        ends_at = ${endsAt}::timestamptz WHERE id = ${params.id}::uuid`;
      row.title = params.data?.title ?? row.title;
      row.starts_at = new Date(startsAt);
      row.ends_at = new Date(endsAt);
    }
    if (row.item_id && row.space_id) await publishSpaceChange(tx, { type: "item.updated", spaceId: row.space_id, itemId: row.item_id });
    return ok(map(row, params.reader));
  });
  if (result.ok) spacesLive.wake();
  return result;
};
export const update = async (params: {
  id: string;
  reader: TimeBlockReader;
  data: UpdateTimeBlock;
  expectedRevision?: string;
}): Promise<Result<SpaceTimeBlock>> => {
  const parsed = UpdateTimeBlockSchema.safeParse(params.data);
  return parsed.success
    ? mutate({ ...params, data: parsed.data })
    : fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid time block"));
};
export const remove = async (params: { id: string; reader: TimeBlockReader; expectedRevision?: string }): Promise<Result<void>> => {
  const result = await mutate({ ...params, remove: true });
  return result.ok ? ok() : result;
};

/** Caller holds the task lock. Only one remaining assignee gives an unambiguous successor. */
export const reconcileAssignees = async (tx: SQL, itemId: string): Promise<void> => {
  await tx`UPDATE spaces.time_blocks b SET space_id = i.space_id FROM spaces.items i
    WHERE b.item_id = i.id AND i.id = ${itemId}::uuid AND b.space_id IS DISTINCT FROM i.space_id`;
  const assignees = await tx<{ user_id: string | null; service_account_id: string | null }[]>`
    SELECT user_id, service_account_id FROM spaces.item_assignees WHERE item_id = ${itemId}::uuid`;
  const stillAssigned = sql`EXISTS (SELECT 1 FROM spaces.item_assignees ia WHERE ia.item_id = b.item_id
    AND (ia.user_id = b.owner_id OR ia.service_account_id = b.owner_service_account_id))`;
  await tx`UPDATE spaces.time_blocks b SET assignment_detached = false
    WHERE b.item_id = ${itemId}::uuid AND b.assignment_detached AND ${stillAssigned}`;
  const successor = assignees.length === 1 ? assignees[0] : undefined;
  if (!successor) {
    // One durable notice per owner/removal episode, even for several blocks and retried task writes.
    await tx`WITH retained AS (
      UPDATE spaces.time_blocks b SET assignment_detached = true
      WHERE b.item_id = ${itemId}::uuid AND NOT b.assignment_detached AND NOT ${stillAssigned}
      RETURNING owner_id, owner_service_account_id
    ) INSERT INTO spaces.time_block_notifications (recipient_id, recipient_service_account_id, direction, recipient_resource_id)
      SELECT DISTINCT r.owner_id, r.owner_service_account_id, 'retained', a.resource_id
      FROM retained r LEFT JOIN auth.service_accounts a ON a.id = r.owner_service_account_id AND a.kind = 'resource_bound'`;
    return;
  }
  const moved = await tx<{ owner_id: string | null; owner_service_account_id: string | null }[]>`
    SELECT DISTINCT b.owner_id, b.owner_service_account_id FROM spaces.time_blocks b
    WHERE b.item_id = ${itemId}::uuid AND NOT ${stillAssigned}`;
  if (!moved.length) return;
  await tx`UPDATE spaces.time_blocks b SET owner_id = ${successor.user_id}::uuid,
    owner_service_account_id = ${successor.service_account_id}::uuid, assignment_detached = false
    WHERE b.item_id = ${itemId}::uuid AND NOT ${stillAssigned}`;
  for (const previous of moved)
    await tx`INSERT INTO spaces.time_block_notifications
    (recipient_id, recipient_service_account_id, direction, recipient_resource_id) VALUES (${previous.owner_id}::uuid, ${previous.owner_service_account_id}::uuid, 'released',
        (SELECT resource_id FROM auth.service_accounts WHERE id = ${previous.owner_service_account_id}::uuid AND kind = 'resource_bound'))`;
  await tx`INSERT INTO spaces.time_block_notifications (recipient_id, recipient_service_account_id, direction, recipient_resource_id)
    VALUES (${successor.user_id}::uuid, ${successor.service_account_id}::uuid, 'received',
      (SELECT resource_id FROM auth.service_accounts WHERE id = ${successor.service_account_id}::uuid AND kind = 'resource_bound'))`;
};
