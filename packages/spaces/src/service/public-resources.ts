import { toPgTextArray, toPgUuidArray } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import type {
  CalendarItem,
  OverlapItem,
  SpaceColumn,
  SpaceComment,
  SpaceItem,
  SpaceTag,
  SpaceTaskDependency,
  SpaceTaskDependent,
  SpaceWormhole,
  SpaceWormholeDestination,
  SpaceWormholeTarget,
} from "../contracts";
import { SHORT_ID_REGEX } from "../lib/short-id";

export type ResourceTable = "spaces" | "columns" | "items" | "comments" | "tags" | "wormholes";
export type SpaceOwnedResourceTable = "columns" | "items" | "tags";

export const resolvePublicId = async (table: ResourceTable, shortId: string): Promise<string | null> => {
  if (!SHORT_ID_REGEX.test(shortId)) return null;
  let rows: { id: string }[];
  switch (table) {
    case "spaces":
      rows = await sql`SELECT id FROM spaces.spaces WHERE short_id = ${shortId}`;
      break;
    case "columns":
      rows = await sql`SELECT id FROM spaces.columns WHERE short_id = ${shortId}`;
      break;
    case "items":
      rows = await sql`SELECT id FROM spaces.items WHERE short_id = ${shortId}`;
      break;
    case "comments":
      rows = await sql`SELECT id FROM spaces.comments WHERE short_id = ${shortId}`;
      break;
    case "tags":
      rows = await sql`SELECT id FROM spaces.tags WHERE short_id = ${shortId}`;
      break;
    case "wormholes":
      rows = await sql`SELECT id FROM spaces.wormholes WHERE short_id = ${shortId}`;
      break;
  }
  return rows[0]?.id ?? null;
};

export const resolvePublicIds = async (table: ResourceTable, values: string[]): Promise<string[] | null> => {
  if (values.length === 0) return [];
  const input = [...new Set(values)];
  if (input.some((value) => !SHORT_ID_REGEX.test(value))) return null;
  const array = toPgTextArray(input);
  let rows: { id: string; short_id: string }[];
  switch (table) {
    case "spaces":
      rows = await sql`SELECT id, short_id FROM spaces.spaces WHERE short_id = ANY(${array}::text[])`;
      break;
    case "columns":
      rows = await sql`SELECT id, short_id FROM spaces.columns WHERE short_id = ANY(${array}::text[])`;
      break;
    case "items":
      rows = await sql`SELECT id, short_id FROM spaces.items WHERE short_id = ANY(${array}::text[])`;
      break;
    case "comments":
      rows = await sql`SELECT id, short_id FROM spaces.comments WHERE short_id = ANY(${array}::text[])`;
      break;
    case "tags":
      rows = await sql`SELECT id, short_id FROM spaces.tags WHERE short_id = ANY(${array}::text[])`;
      break;
    case "wormholes":
      rows = await sql`SELECT id, short_id FROM spaces.wormholes WHERE short_id = ANY(${array}::text[])`;
      break;
  }
  const byShortId = new Map(rows.map((row) => [row.short_id, row.id]));
  return input.every((value) => byShortId.has(value)) ? values.map((value) => byShortId.get(value)!) : null;
};

export const resolveSpacePublicIds = async (
  table: SpaceOwnedResourceTable,
  spaceId: string,
  values: string[],
): Promise<string[] | null> => {
  if (values.length === 0) return [];
  const input = [...new Set(values)];
  if (input.some((value) => !SHORT_ID_REGEX.test(value))) return null;
  const array = toPgTextArray(input);
  let rows: { id: string; short_id: string }[];
  switch (table) {
    case "columns":
      rows = await sql`SELECT id, short_id FROM spaces.columns WHERE space_id = ${spaceId}::uuid AND short_id = ANY(${array}::text[])`;
      break;
    case "items":
      rows = await sql`SELECT id, short_id FROM spaces.items WHERE space_id = ${spaceId}::uuid AND short_id = ANY(${array}::text[])`;
      break;
    case "tags":
      rows = await sql`SELECT id, short_id FROM spaces.tags WHERE space_id = ${spaceId}::uuid AND short_id = ANY(${array}::text[])`;
      break;
  }
  const byShortId = new Map(rows.map((row) => [row.short_id, row.id]));
  return input.every((value) => byShortId.has(value)) ? values.map((value) => byShortId.get(value)!) : null;
};

const shortIds = async (table: ResourceTable, ids: (string | null | undefined)[]): Promise<Map<string, string>> => {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const array = toPgUuidArray(unique);
  let rows: { id: string; short_id: string }[];
  switch (table) {
    case "spaces":
      rows = await sql`SELECT id, short_id FROM spaces.spaces WHERE id = ANY(${array}::uuid[])`;
      break;
    case "columns":
      rows = await sql`SELECT id, short_id FROM spaces.columns WHERE id = ANY(${array}::uuid[])`;
      break;
    case "items":
      rows = await sql`SELECT id, short_id FROM spaces.items WHERE id = ANY(${array}::uuid[])`;
      break;
    case "comments":
      rows = await sql`SELECT id, short_id FROM spaces.comments WHERE id = ANY(${array}::uuid[])`;
      break;
    case "tags":
      rows = await sql`SELECT id, short_id FROM spaces.tags WHERE id = ANY(${array}::uuid[])`;
      break;
    case "wormholes":
      rows = await sql`SELECT id, short_id FROM spaces.wormholes WHERE id = ANY(${array}::uuid[])`;
      break;
  }
  return new Map(rows.map((row) => [row.id, row.short_id]));
};

const required = (map: Map<string, string>, id: string): string => {
  const value = map.get(id);
  if (!value) throw new Error(`Missing public ID for Spaces resource ${id}`);
  return value;
};

export const projectSpaces = async <T extends { id: string }>(items: T[]): Promise<T[]> => {
  const ids = await shortIds(
    "spaces",
    items.map((item) => item.id),
  );
  return items.map((item) => ({ ...item, id: required(ids, item.id) }));
};

export const projectColumns = async <T extends SpaceColumn>(items: T[]): Promise<T[]> => {
  const [ids, spaces] = await Promise.all([
    shortIds(
      "columns",
      items.map((item) => item.id),
    ),
    shortIds(
      "spaces",
      items.map((item) => item.spaceId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: required(ids, item.id), spaceId: required(spaces, item.spaceId) }));
};

export const projectTags = async <T extends SpaceTag>(items: T[]): Promise<T[]> => {
  const [ids, spaces] = await Promise.all([
    shortIds(
      "tags",
      items.map((item) => item.id),
    ),
    shortIds(
      "spaces",
      items.map((item) => item.spaceId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: required(ids, item.id), spaceId: required(spaces, item.spaceId) }));
};

export const projectItems = async <T extends SpaceItem>(items: T[]): Promise<T[]> => {
  const tagIds = items.flatMap((item) => item.tags?.map((tag) => tag.id) ?? []);
  const [ids, spaces, columns, recurring, tags] = await Promise.all([
    shortIds(
      "items",
      items.map((item) => item.id),
    ),
    shortIds(
      "spaces",
      items.map((item) => item.spaceId),
    ),
    shortIds(
      "columns",
      items.map((item) => item.columnId),
    ),
    shortIds(
      "items",
      items.map((item) => item.recurringEventId),
    ),
    shortIds("tags", tagIds),
  ]);
  return items.map((item) => ({
    ...item,
    id: required(ids, item.id),
    spaceId: required(spaces, item.spaceId),
    columnId: required(columns, item.columnId),
    recurringEventId: item.recurringEventId ? required(recurring, item.recurringEventId) : null,
    tags: item.tags?.map((tag) => ({ ...tag, id: required(tags, tag.id), spaceId: required(spaces, tag.spaceId) })),
  }));
};

export const projectItemReferences = async <T extends { id: string; spaceId: string }>(items: T[]): Promise<T[]> => {
  const [itemIds, spaceIds] = await Promise.all([
    shortIds(
      "items",
      items.map((item) => item.id),
    ),
    shortIds(
      "spaces",
      items.map((item) => item.spaceId),
    ),
  ]);
  return items.map((item) => ({
    ...item,
    id: required(itemIds, item.id),
    spaceId: required(spaceIds, item.spaceId),
  }));
};

export const projectTaskDependencies = async <T extends SpaceTaskDependency>(items: T[]): Promise<T[]> => {
  const [itemIds, spaceIds] = await Promise.all([
    shortIds(
      "items",
      items.map((item) => item.blocker.id),
    ),
    shortIds(
      "spaces",
      items.map((item) => item.blocker.spaceId),
    ),
  ]);
  return items.map((item) => ({
    ...item,
    blocker: {
      ...item.blocker,
      id: required(itemIds, item.blocker.id),
      spaceId: required(spaceIds, item.blocker.spaceId),
    },
  }));
};

export const projectTaskDependents = async <T extends SpaceTaskDependent>(items: T[]): Promise<T[]> => {
  const [itemIds, spaceIds] = await Promise.all([
    shortIds(
      "items",
      items.map((item) => item.dependent.id),
    ),
    shortIds(
      "spaces",
      items.map((item) => item.dependent.spaceId),
    ),
  ]);
  return items.map((item) => ({
    ...item,
    dependent: {
      ...item.dependent,
      id: required(itemIds, item.dependent.id),
      spaceId: required(spaceIds, item.dependent.spaceId),
    },
  }));
};

export const projectComments = async <T extends SpaceComment>(items: T[]): Promise<T[]> => {
  const [ids, itemIds] = await Promise.all([
    shortIds(
      "comments",
      items.map((item) => item.id),
    ),
    shortIds(
      "items",
      items.map((item) => item.itemId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: required(ids, item.id), itemId: required(itemIds, item.itemId) }));
};

export const projectWormholes = async <T extends SpaceWormhole>(items: T[]): Promise<T[]> => {
  const targets = items.flatMap((item) => (item.target ? [item.target] : []));
  const [ids, spaces, columns] = await Promise.all([
    shortIds(
      "wormholes",
      items.map((item) => item.id),
    ),
    shortIds("spaces", [...items.map((item) => item.sourceSpaceId), ...targets.map((target) => target.spaceId)]),
    shortIds(
      "columns",
      targets.map((target) => target.columnId),
    ),
  ]);
  return items.map((item) => ({
    ...item,
    id: required(ids, item.id),
    sourceSpaceId: required(spaces, item.sourceSpaceId),
    target: item.target
      ? {
          ...item.target,
          spaceId: required(spaces, item.target.spaceId),
          columnId: required(columns, item.target.columnId),
        }
      : null,
  }));
};

export const projectWormholeTargets = async <T extends SpaceWormholeTarget>(items: T[]): Promise<T[]> => {
  const [spaces, columns] = await Promise.all([
    shortIds(
      "spaces",
      items.map((item) => item.spaceId),
    ),
    shortIds(
      "columns",
      items.map((item) => item.columnId),
    ),
  ]);
  return items.map((item) => ({
    ...item,
    spaceId: required(spaces, item.spaceId),
    columnId: required(columns, item.columnId),
  }));
};

export const projectWormholeDestinations = async <T extends SpaceWormholeDestination>(items: T[]): Promise<T[]> => {
  const spaces = await shortIds(
    "spaces",
    items.map((item) => item.spaceId),
  );
  const columns = await shortIds(
    "columns",
    items.flatMap((item) => item.columns.map((column) => column.id)),
  );
  return items.map((item) => ({
    ...item,
    spaceId: required(spaces, item.spaceId),
    columns: item.columns.map((column) => ({
      ...column,
      id: required(columns, column.id),
      spaceId: required(spaces, column.spaceId),
    })),
  }));
};

export const projectCalendarItems = async <T extends CalendarItem>(items: T[]): Promise<T[]> => {
  const baseIds = items.map((item) => item.id.split(":", 1)[0] ?? item.id);
  const [itemIds, spaceIds, recurringIds, tagIds] = await Promise.all([
    shortIds("items", baseIds),
    shortIds(
      "spaces",
      items.map((item) => item.spaceId),
    ),
    shortIds(
      "items",
      items.map((item) => item.recurringEventId),
    ),
    shortIds(
      "tags",
      items.flatMap((item) => item.tags?.map((tag) => tag.id) ?? []),
    ),
  ]);
  return items.map((item, index) => {
    const suffix = item.id.slice(baseIds[index]!.length);
    return {
      ...item,
      id: `${required(itemIds, baseIds[index]!)}${suffix}`,
      spaceId: required(spaceIds, item.spaceId),
      recurringEventId: item.recurringEventId ? required(recurringIds, item.recurringEventId) : null,
      tags: item.tags?.map((tag) => ({
        ...tag,
        id: required(tagIds, tag.id),
        spaceId: required(spaceIds, tag.spaceId),
      })),
    };
  });
};

export const projectOverlapItems = async <T extends OverlapItem>(items: T[]): Promise<T[]> => {
  const [itemIds, spaceIds] = await Promise.all([
    shortIds(
      "items",
      items.map((item) => item.itemId),
    ),
    shortIds(
      "spaces",
      items.map((item) => item.spaceId),
    ),
  ]);
  return items.map((item) => ({
    ...item,
    itemId: required(itemIds, item.itemId),
    spaceId: required(spaceIds, item.spaceId),
  }));
};

export const spacesPublicResources = {
  resolvePublicId,
  resolvePublicIds,
  resolveSpacePublicIds,
  projectSpaces,
  projectColumns,
  projectTags,
  projectItems,
  projectItemReferences,
  projectTaskDependencies,
  projectTaskDependents,
  projectComments,
  projectWormholes,
  projectWormholeTargets,
  projectWormholeDestinations,
  projectCalendarItems,
  projectOverlapItems,
};
