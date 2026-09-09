import { sql } from "bun";
import { toPgUuidArray } from "@k2b/cloud/services";
import { err, fail, ok, paginate, type PageParams, type Paginated } from "@k2b/stdlib";
import type { ProxyAuthAllowedGroup, ProxyAuthClient, CreateProxyAuthClient, UpdateProxyAuthClient } from "@/contracts";

type Db = typeof sql;

type ClientRow = {
  id: string;
  name: string;
  client_id: string;
  description: string | null;
  created_at: string | Date;
  allowed_groups: ProxyAuthAllowedGroup[];
};

/**
 * Normalizes unknown throw values into a stable error message string.
 */
const toErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
};

/**
 * Converts one joined proxy-auth client row into the `ProxyAuthClient` DTO.
 */
const mapRow = (row: ClientRow): ProxyAuthClient => ({
  id: row.id,
  name: row.name,
  clientId: row.client_id,
  description: row.description,
  allowedGroups: row.allowed_groups ?? [],
  createdAt: new Date(row.created_at).toISOString(),
});

const paginateItems = <T>(items: T[], pagination?: PageParams): Paginated<T> => {
  if (!pagination) {
    return {
      items,
      page: 1,
      perPage: items.length,
      total: items.length,
      hasNext: false,
    };
  }

  const { page, perPage, offset } = paginate(pagination);
  const pagedItems = items.slice(offset, offset + perPage);
  return {
    items: pagedItems,
    page,
    perPage,
    total: items.length,
    hasNext: page * perPage < items.length,
  };
};

/**
 * Lists proxy-auth clients with their allowed groups, with optional search and pagination.
 */
const list = async (config?: { pagination?: PageParams; filter?: { query?: string } }): Promise<Paginated<ProxyAuthClient>> => {
  const rows = await sql<ClientRow[]>`
    SELECT c.*,
      COALESCE(
        json_agg(
          json_build_object(
            'id', g.id,
            'name', g.name,
            'provider', g.provider
          )
          ORDER BY g.name
        ) FILTER (WHERE cg.group_id IS NOT NULL),
        '[]'::json
      ) as allowed_groups
    FROM proxy_auth.clients c
    LEFT JOIN proxy_auth.client_groups cg ON c.id = cg.client_id
    LEFT JOIN auth.groups g ON cg.group_id = g.id
    GROUP BY c.id
    ORDER BY c.name
  `;
  const query = config?.filter?.query?.trim().toLowerCase();
  const items = rows.map(mapRow);
  const filtered =
    query && query.length > 0
      ? items.filter((client) => {
          const description = client.description ?? "";
          return (
            client.name.toLowerCase().includes(query) ||
            client.clientId.toLowerCase().includes(query) ||
            description.toLowerCase().includes(query)
          );
        })
      : items;

  return paginateItems(filtered, config?.pagination);
};

/**
 * Loads a proxy-auth client by internal id including allowed group links.
 */
const get = async (config: { id: string }): Promise<ProxyAuthClient | null> => {
  const rows = await sql`
    SELECT c.*,
      COALESCE(
        json_agg(
          json_build_object(
            'id', g.id,
            'name', g.name,
            'provider', g.provider
          )
          ORDER BY g.name
        ) FILTER (WHERE cg.group_id IS NOT NULL),
        '[]'::json
      ) as allowed_groups
    FROM proxy_auth.clients c
    LEFT JOIN proxy_auth.client_groups cg ON c.id = cg.client_id
    LEFT JOIN auth.groups g ON cg.group_id = g.id
    WHERE c.id = ${config.id}
    GROUP BY c.id
  `;
  return rows.length > 0 ? mapRow(rows[0] as ClientRow) : null;
};

/**
 * Loads a proxy-auth client by external `client_id` used in verify URLs.
 */
const getByClientId = async (config: { clientId: string }): Promise<ProxyAuthClient | null> => {
  const rows = await sql`
    SELECT c.*,
      COALESCE(
        json_agg(
          json_build_object(
            'id', g.id,
            'name', g.name,
            'provider', g.provider
          )
          ORDER BY g.name
        ) FILTER (WHERE cg.group_id IS NOT NULL),
        '[]'::json
      ) as allowed_groups
    FROM proxy_auth.clients c
    LEFT JOIN proxy_auth.client_groups cg ON c.id = cg.client_id
    LEFT JOIN auth.groups g ON cg.group_id = g.id
    WHERE c.client_id = ${config.clientId}
    GROUP BY c.id
  `;
  return rows.length > 0 ? mapRow(rows[0] as ClientRow) : null;
};

const validateGroupIds = async (db: Db, groupIds: string[]) => {
  const rows = await db<{ id: string }[]>`
    SELECT id
    FROM auth.groups
    WHERE id = ANY(${toPgUuidArray(groupIds)}::uuid[])
  `;
  if (rows.length !== groupIds.length) {
    return fail(err.badInput("One or more allowed groups do not exist."));
  }
  return ok();
};

const replaceAllowedGroups = async (db: Db, clientId: string, groupIds: string[]) => {
  const validation = await validateGroupIds(db, groupIds);
  if (!validation.ok) return validation;

  await db`DELETE FROM proxy_auth.client_groups WHERE client_id = ${clientId}::uuid`;
  for (const groupId of groupIds) {
    await db`
      INSERT INTO proxy_auth.client_groups (client_id, group_id)
      VALUES (${clientId}::uuid, ${groupId}::uuid)
    `;
  }
  return ok();
};

/**
 * Creates a proxy-auth client and persists its allowed-group links.
 */
const create = async (config: { data: CreateProxyAuthClient; createdBy: string }) => {
  const { data, createdBy } = config;

  try {
    const result = await sql.begin(async (tx) => {
      const groups = await validateGroupIds(tx, data.allowedGroupIds);
      if (!groups.ok) return groups;

      const rows = await tx`
      INSERT INTO proxy_auth.clients (name, description, created_by)
      VALUES (${data.name}, ${data.description ?? null}, ${createdBy})
      RETURNING *
    `;
      const client = rows[0]!;

      for (const groupId of data.allowedGroupIds) {
        await tx`
        INSERT INTO proxy_auth.client_groups (client_id, group_id)
        VALUES (${client.id}, ${groupId})
      `;
      }

      return ok(client.id as string);
    });
    if (!result.ok) return result;

    const client = await get({ id: result.data });
    if (!client) return fail(err.internal("Failed to load created client."));
    return ok(client);
  } catch (error: unknown) {
    const message = toErrorMessage(error, "Failed to create client.");
    if (message.includes("unique") || (error as { code?: string })?.code === "23505") {
      return fail(err.badInput("A client with this name already exists."));
    }
    return fail(err.internal(message));
  }
};

/**
 * Updates mutable client fields and replaces allowed-group links when provided.
 */
const update = async (config: { id: string; data: UpdateProxyAuthClient }) => {
  const { id, data } = config;

  try {
    return await sql.begin(async (tx) => {
      const existing = await tx`SELECT id FROM proxy_auth.clients WHERE id = ${id}::uuid`;
      if (existing.length === 0) {
        return fail(err.notFound("Client"));
      }

      if (data.allowedGroupIds) {
        const groups = await replaceAllowedGroups(tx, id, data.allowedGroupIds);
        if (!groups.ok) return groups;
      }

      if (data.description !== undefined) {
        await tx`UPDATE proxy_auth.clients SET description = ${data.description} WHERE id = ${id}::uuid`;
      }

      return ok();
    });
  } catch (error: unknown) {
    return fail(err.internal(toErrorMessage(error, "Failed to update client.")));
  }
};

/**
 * Deletes one proxy-auth client by UUID and returns `NOT_FOUND` when missing.
 */
const remove = async (config: { id: string }) => {
  try {
    const rows = await sql`DELETE FROM proxy_auth.clients WHERE id = ${config.id}::uuid RETURNING id`;
    if (rows.length === 0) {
      return fail(err.notFound("Client"));
    }
    return ok();
  } catch (error: unknown) {
    return fail(err.internal(toErrorMessage(error, "Failed to delete client.")));
  }
};

export const proxyAuthService = {
  client: {
    list,
    get,
    getByClientId,
    create,
    update,
    remove,
  },
};

export type ProxyAuthService = typeof proxyAuthService;
