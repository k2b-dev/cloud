import type { AccessSubject } from "@k2b/cloud/contracts";
import { hasPermission, type RequestActor } from "@k2b/cloud/server";
import type { DateContext } from "@k2b/stdlib";
import { z } from "zod";
import type { ItemFilter, SpaceItem, SpaceItemAssignee } from "@/contracts";
import { getActorsSpacePermissions } from "@/service/access";
import { spacesService } from "@/service/index";
import { loadSpacesSidebar } from "@/service/overview";
import { resolvePublicId, resolveSpacePublicIds, spacesPublicResources } from "@/service/public-resources";
import { isTaskOverdue } from "@/task-overdue";
import type { SpaceListFilter } from "./paths";

/** Rows of one status per page, as a board column on the web shows them. */
export const PWA_STATUS_PAGE_SIZE = 30;
/** The most pages of one status a single read returns, such as when the list reads again what it already shows. */
const MAX_PAGES_PER_READ = 20;

/** A status of a Space, a column on the web board; a done status completes its tasks. */
export type PwaStatus = { id: string; name: string; color: string; done: boolean };
export type PwaTag = { id: string; name: string; color: string };
/** One task or event of a Space list, with what its row shows. */
export type PwaRow = {
  shortId: string;
  title: string;
  statusId: string;
  completed: boolean;
  startsAt: string | null;
  endsAt: string | null;
  deadline: string | null;
  deadlineAllDay: boolean;
  /** An open task past its deadline in the reader's time zone. */
  overdue: boolean;
  /** An open task with unfinished blocking tasks. */
  blocked: boolean;
  checklist: { done: number; total: number } | null;
  tags: PwaTag[];
  people: SpaceItemAssignee[];
};
/** The rows of one status the list has read so far; a done status reads none until it is unfolded. */
export type PwaGroup = { statusId: string; total: number; rows: PwaRow[]; pages: number; totalPages: number };
/** A Space in the mobile app: its statuses and tags, what the reader may do, and the first rows of each status. */
export type PwaSpace = {
  shortId: string;
  name: string;
  color: string;
  canWrite: boolean;
  statuses: PwaStatus[];
  tags: PwaTag[];
  filter: SpaceListFilter;
  groups: PwaGroup[];
};
/** A Space the title switches to, with one fact: how much is open, or that the reader may only read it. */
export type PwaSpaceEntry = { shortId: string; name: string; color: string; openCount: number; canWrite: boolean; pinned: boolean };

const positive = z.coerce.number().int().min(1).max(10_000).catch(1);

/** The pages of each status a read covers: `load=<status>:<pages>`; open statuses default to one, done ones to none. */
export const parsePwaSpaceLoad = (url: URL): Map<string, number> =>
  new Map(
    url.searchParams.getAll("load").flatMap((entry) => {
      const [statusId, pages] = entry.split(":");
      const count = Number(pages);
      return statusId && Number.isInteger(count) && count >= 0 ? [[statusId, Math.min(count, MAX_PAGES_PER_READ)] as const] : [];
    }),
  );

export const parsePwaGroupPage = (url: URL) => ({
  statusId: url.searchParams.get("status") ?? "",
  page: positive.parse(url.searchParams.get("page")),
});

type Reader = { actor: RequestActor; subject: AccessSubject; userId: string; dateConfig: DateContext };
type Resolved = { spaceId: string; canWrite: boolean };

/** The Space a public ID names when the reader may read it, with the same permission check as the API; null otherwise. */
const resolveReadable = async (spaceShortId: string, reader: Reader): Promise<Resolved | null> => {
  const spaceId = await resolvePublicId("spaces", spaceShortId);
  if (!spaceId) return null;
  const [permission = "none"] = await getActorsSpacePermissions(spaceId, [{ actor: reader.actor, subject: reader.subject }]);
  if (!hasPermission(permission, "read")) return null;
  return { spaceId, canWrite: hasPermission(permission, "write") };
};

/** One status's page as the web board reads it, narrowed by the list's filter; a done status keeps every task. */
const statusFilter = (params: {
  columnId: string;
  done: boolean;
  filter: SpaceListFilter;
  tagIds: string[];
  page: number;
  pageSize: number;
}): ItemFilter => ({
  type: "all",
  status: params.done ? "completed" : "active",
  activity: "all",
  tagIds: params.tagIds.length ? params.tagIds : undefined,
  columnIds: [params.columnId],
  assignedTo: params.filter.mine ? "me" : "all",
  deadlineFilter: "all",
  search: params.filter.search || undefined,
  sort: "column",
  sortDesc: false,
  groupBy: "none",
  page: params.page,
  pageSize: params.pageSize,
});

const projectRows = async (items: SpaceItem[], dateConfig: DateContext): Promise<PwaRow[]> => {
  const [projected, progress] = await Promise.all([
    spacesPublicResources.projectItems(items),
    spacesService.item.checklist.progress({ itemIds: items.filter((item) => !item.startsAt).map((item) => item.id) }),
  ]);
  return projected.map((item, index) => {
    const open = item.completedAt === null;
    return {
      shortId: item.id,
      title: item.title,
      statusId: item.columnId,
      completed: !open,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      deadline: item.deadline,
      deadlineAllDay: item.deadlineAllDay,
      overdue: isTaskOverdue(item, dateConfig),
      blocked: open && item.activeBlockerCount > 0,
      checklist: progress.get(items[index]!.id) ?? null,
      tags: (item.tags ?? []).map(({ id, name, color }) => ({ id, name, color })),
      people: item.assignees ?? [],
    };
  });
};

const readGroup = async (params: {
  spaceId: string;
  status: PwaStatus & { internalId: string };
  filter: SpaceListFilter;
  tagIds: string[];
  page: number;
  pages: number;
  reader: Reader;
}): Promise<PwaGroup> => {
  // A done status reads only its count until it is unfolded.
  const pageSize = PWA_STATUS_PAGE_SIZE * Math.max(1, params.pages);
  const result = await spacesService.item.listFiltered({
    spaceId: params.spaceId,
    filter: statusFilter({
      columnId: params.status.internalId,
      done: params.status.done,
      filter: params.filter,
      tagIds: params.tagIds,
      page: params.pages > 0 ? params.page : 1,
      pageSize: params.pages > 0 ? pageSize : 1,
    }),
    currentUserId: params.reader.userId,
    viewer: { kind: "user", id: params.reader.userId },
    dateConfig: params.reader.dateConfig,
  });
  return {
    statusId: params.status.id,
    total: result.total,
    rows: params.pages > 0 ? await projectRows(result.items, params.reader.dateConfig) : [],
    pages: params.pages > 0 ? params.page - 1 + params.pages : 0,
    totalPages: Math.ceil(result.total / PWA_STATUS_PAGE_SIZE),
  };
};

type SpaceShape = { resolved: Resolved; space: Omit<PwaSpace, "groups" | "filter">; statuses: (PwaStatus & { internalId: string })[] };

/** The filter with only tags the Space still has, and their internal IDs: a removed tag filters nothing. */
const resolveFilter = async (shape: SpaceShape, filter: SpaceListFilter) => {
  const known = filter.tagIds.filter((id) => shape.space.tags.some((tag) => tag.id === id));
  const tagIds = (await resolveSpacePublicIds("tags", shape.resolved.spaceId, known)) ?? [];
  return { filter: { ...filter, tagIds: known }, tagIds };
};

const readShape = async (spaceShortId: string, reader: Reader): Promise<SpaceShape | null> => {
  const resolved = await resolveReadable(spaceShortId, reader);
  if (!resolved) return null;
  const detail = await spacesService.space.getDetail({ id: resolved.spaceId });
  if (!detail) return null;
  const projected = await spacesPublicResources.projectSpaceDetail(detail);
  const statuses = projected.columns.map((column, index) => ({
    id: column.id,
    internalId: detail.columns[index]!.id,
    name: column.name,
    color: column.color ?? "var(--k2b-text-muted)",
    done: column.isDone,
  }));
  return {
    resolved,
    statuses,
    space: {
      shortId: spaceShortId,
      name: projected.name,
      color: projected.color,
      canWrite: resolved.canWrite,
      statuses: statuses.map(({ internalId: _, ...status }) => status),
      tags: projected.tags.map(({ id, name, color }) => ({ id, name, color })),
    },
  };
};

/**
 * The Space `spaceShortId` as its list opens: every status with its first page, a done status with its count only,
 * narrowed by `filter`; `load` names statuses that read more pages, such as when the list reads again what it shows.
 * Null when the Space does not exist or the reader may not read it, so an address never tells that it exists.
 */
export async function loadPwaSpace(params: {
  spaceShortId: string;
  filter: SpaceListFilter;
  load?: ReadonlyMap<string, number>;
  reader: Reader;
}): Promise<PwaSpace | null> {
  const shape = await readShape(params.spaceShortId, params.reader);
  if (!shape) return null;
  const { filter, tagIds } = await resolveFilter(shape, params.filter);
  const searching = filter.search.length > 0;
  const groups = await Promise.all(
    shape.statuses
      // A search looks through open tasks only.
      .filter((status) => !(searching && status.done))
      .map((status) =>
        readGroup({
          spaceId: shape.resolved.spaceId,
          status,
          filter,
          tagIds,
          page: 1,
          pages: params.load?.get(status.id) ?? (status.done ? 0 : 1),
          reader: params.reader,
        }),
      ),
  );
  return { ...shape.space, filter, groups };
}

/** One further page of one status, read with the list's filter; null as for `loadPwaSpace`, or for an unknown status. */
export async function loadPwaGroupPage(params: {
  spaceShortId: string;
  statusId: string;
  page: number;
  filter: SpaceListFilter;
  reader: Reader;
}): Promise<PwaGroup | null> {
  const shape = await readShape(params.spaceShortId, params.reader);
  const status = shape?.statuses.find((entry) => entry.id === params.statusId);
  if (!shape || !status) return null;
  const { filter, tagIds } = await resolveFilter(shape, params.filter);
  return readGroup({ spaceId: shape.resolved.spaceId, status, filter, tagIds, page: params.page, pages: 1, reader: params.reader });
}

/** Every Space the title switches to, pinned ones first in their order on the web, then as the web lists them. */
export async function loadPwaSpaceEntries(params: {
  userId: string;
  cookieHeader?: string;
  myWorkCount: number;
}): Promise<PwaSpaceEntry[]> {
  const [sidebar, writable] = await Promise.all([
    loadSpacesSidebar({ userId: params.userId, cookieHeader: params.cookieHeader, myWorkCount: params.myWorkCount }),
    spacesService.space.list({ subject: { type: "user", userId: params.userId }, requiredLevel: "write" }),
  ]);
  const writableIds = new Set((await spacesPublicResources.projectSpaces(writable.items)).map((space) => space.id));
  const pinRank = (id: string) => {
    const rank = sidebar.pinnedSpaceIds.indexOf(id);
    return rank < 0 ? sidebar.pinnedSpaceIds.length : rank;
  };
  return sidebar.spaces
    .map((space) => ({
      shortId: space.id,
      name: space.name,
      color: space.color,
      openCount: space.openItemCount,
      canWrite: writableIds.has(space.id),
      pinned: sidebar.pinnedSpaceIds.includes(space.id),
    }))
    .sort((a, b) => pinRank(a.shortId) - pinRank(b.shortId));
}
