import {
  type AccessSubject,
  buildAccessPrincipalCondition,
  err,
  fail,
  ok,
  type RequestActor,
  type Result,
} from "@valentinkolb/cloud/server";
import { escapeLikePattern, isUniqueViolation, secrets, toPgTextArray, toPgUuidArray } from "@valentinkolb/cloud/services";
import { sql } from "bun";

type InventoryItem = {
  id: string;
  name: string;
  quantity: number;
  labels: string[];
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

type DbInventoryItem = {
  id: string;
  name: string;
  quantity: number;
  labels: string[] | null;
  metadata: unknown;
  created_at: Date | string;
};

const mapJsonRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const mapInventoryItem = (row: DbInventoryItem): InventoryItem => ({
  id: row.id,
  name: row.name,
  quantity: row.quantity,
  labels: row.labels ?? [],
  metadata: mapJsonRecord(row.metadata),
  createdAt: new Date(row.created_at).toISOString(),
});

export const migrateInventory = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS inventory`.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS inventory.items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      quantity INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      labels TEXT[] NOT NULL DEFAULT '{}'::text[],
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (name)
    )
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS inventory_items_created_at
    ON inventory.items (created_at DESC, id)
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS inventory.item_access (
      item_id UUID NOT NULL
        REFERENCES inventory.items(id) ON DELETE CASCADE,
      access_id UUID NOT NULL
        REFERENCES auth.access(id) ON DELETE CASCADE,
      PRIMARY KEY (item_id, access_id)
    )
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS inventory.stock_movements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      item_id UUID NOT NULL
        REFERENCES inventory.items(id) ON DELETE CASCADE,
      delta INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS inventory.integration_credentials (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      value_encrypted TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
};

export const listInventoryItems = async (input: {
  search?: string;
  ids?: string[];
  labels?: string[];
  sort: "name" | "quantity";
  direction: "asc" | "desc";
  limit: number;
  offset: number;
  actor: RequestActor;
  accessSubject: AccessSubject;
}): Promise<Result<InventoryItem[]>> => {
  if (input.actor.kind === "service_account" && input.actor.delegatedUser === null) {
    return fail(err.forbidden("Resource credentials cannot list items"));
  }

  const search = input.search?.trim();
  const pattern = search ? `%${escapeLikePattern(search.toLowerCase())}%` : null;
  const ids = toPgUuidArray(input.ids);
  const labels = toPgTextArray(input.labels);
  const orderBy = input.sort === "quantity" ? sql`i.quantity` : sql`LOWER(i.name)`;
  const direction = input.direction === "desc" ? sql`DESC` : sql`ASC`;
  const principal = buildAccessPrincipalCondition({
    subject: input.accessSubject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });

  const rows = await sql<DbInventoryItem[]>`
    SELECT
      i.id,
      i.name,
      i.quantity,
      i.labels,
      i.metadata,
      i.created_at
    FROM inventory.items i
    WHERE (
      ${pattern}::text IS NULL
      OR LOWER(i.name) LIKE ${pattern} ESCAPE '\'
    )
      AND (
        ${input.ids?.length ?? 0} = 0
        OR i.id = ANY(${ids}::uuid[])
      )
      AND (
        ${input.labels?.length ?? 0} = 0
        OR i.labels && ${labels}::text[]
      )
      AND EXISTS (
        SELECT 1
        FROM inventory.item_access ia
        JOIN auth.access a ON a.id = ia.access_id
        WHERE ia.item_id = i.id
          AND ${principal}
          AND a.permission IN ('read', 'write', 'admin')
      )
    ORDER BY ${orderBy} ${direction}, i.id
    LIMIT ${input.limit}
    OFFSET ${input.offset}
  `;

  return ok(rows.map(mapInventoryItem));
};

export const createInventoryItem = async (input: { name: string; quantity: number }): Promise<Result<InventoryItem>> => {
  try {
    const [row] = await sql<DbInventoryItem[]>`
      INSERT INTO inventory.items (name, quantity)
      VALUES (${input.name}, ${input.quantity})
      RETURNING id, name, quantity, labels, metadata, created_at
    `;

    return row ? ok(mapInventoryItem(row)) : fail(err.internal("Inventory item was not created"));
  } catch (error) {
    return isUniqueViolation(error) ? fail(err.conflict("Inventory item name")) : fail(err.internal("Inventory item was not created"));
  }
};

export const adjustInventoryStock = async (input: { itemId: string; delta: number }): Promise<Result<InventoryItem>> =>
  sql.begin(async (tx) => {
    const [current] = await tx<DbInventoryItem[]>`
      SELECT id, name, quantity, labels, metadata, created_at
      FROM inventory.items
      WHERE id = ${input.itemId}::uuid
      FOR UPDATE
    `;
    if (!current) return fail(err.notFound("Inventory item"));

    const nextQuantity = current.quantity + input.delta;
    if (nextQuantity < 0) {
      return fail(err.conflict("Stock cannot become negative"));
    }

    const [updated] = await tx<DbInventoryItem[]>`
      UPDATE inventory.items
      SET quantity = ${nextQuantity}
      WHERE id = ${input.itemId}::uuid
      RETURNING id, name, quantity, labels, metadata, created_at
    `;

    await tx`
      INSERT INTO inventory.stock_movements (item_id, delta)
      VALUES (${input.itemId}::uuid, ${input.delta})
    `;

    return updated ? ok(mapInventoryItem(updated)) : fail(err.internal("Inventory item was not updated"));
  });

export const storeIntegrationCredential = async (input: { name: string; apiKey: string }): Promise<string> => {
  const encrypted = await secrets.encrypt({ apiKey: input.apiKey });
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO inventory.integration_credentials (name, value_encrypted)
    VALUES (${input.name}, ${encrypted})
    RETURNING id
  `;
  if (!row) throw new Error("Credential was not stored");
  return row.id;
};

export const readIntegrationCredential = async (id: string): Promise<{ apiKey: string } | null> => {
  const [row] = await sql<{ value_encrypted: string }[]>`
    SELECT value_encrypted
    FROM inventory.integration_credentials
    WHERE id = ${id}::uuid
  `;
  return row ? secrets.decrypt<{ apiKey: string }>(row.value_encrypted) : null;
};
