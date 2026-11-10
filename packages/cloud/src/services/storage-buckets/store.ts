import type { SQL } from "bun";
import { z } from "zod";
import {
  ObjectStoreConfigurationError,
  ObjectStoreConnectionError,
  objectStoreBackend,
  objectStoreSettingKeys,
  persistedSignature,
  resolveObjectStoreConfig,
  storageEndpointIsValid,
  testObjectStoreBackend,
} from "../../_internal/object-store-config";
import {
  type AdminStorageBucket,
  DEFAULT_STORAGE_BUCKET_ID,
  parseStorageBucketId,
  type StorageBucketCheck,
  type StorageBucketCheckStep,
  type StorageBucketCreate,
  StorageBucketCreateSchema,
  type StorageBucketErrorCode,
  type StorageBucketId,
  StorageBucketIdSchema,
  type StorageBucketRestore,
  StorageBucketRestoreSchema,
  type StorageBucketUpdate,
  StorageBucketUpdateSchema,
  type StorageBucketUsage,
} from "../../contracts/storage-buckets";
import { sql } from "../../runtime/clients";
import { type AuditActor, audit } from "../audit";
import { isUniqueViolation } from "../postgres";
import { decryptValue, encryptValue } from "../settings/crypto";
import { readStates } from "../settings/store";
import { hasDatabaseErrorCode, readStorageBucketRows, type StorageBucketRow } from "./rows";

export class StorageBucketError extends Error {
  constructor(
    public readonly code: StorageBucketErrorCode,
    message: string,
    public readonly status: 400 | 404 | 409 | 502 = 400,
    public readonly current?: AdminStorageBucket,
  ) {
    super(message);
  }
}
export type StorageBucketAuditContext = { actor: AuditActor; requestId?: string };
type CheckRow = { bucket_id: string; signature: string; ok: boolean; step: StorageBucketCheckStep | null; checked_at: Date | string };
const timestamp = (value: Date | string) => new Date(value).toISOString();
const untested = (): StorageBucketCheck => ({ state: "untested", step: null, checkedAt: null });
export const storageBucketCheck = (row: CheckRow | undefined, signature: string | null): StorageBucketCheck =>
  !row || row.signature !== signature
    ? untested()
    : { state: row.ok ? "ok" : "failed", step: row.step, checkedAt: timestamp(row.checked_at) };
const idValue = (value: string): StorageBucketId => {
  const id = parseStorageBucketId(value);
  if (!id) throw new StorageBucketError("storage_bucket_invalid", "Invalid storage bucket ID.");
  return id;
};
const mutableId = (value: string) => {
  const id = idValue(value);
  if (id === DEFAULT_STORAGE_BUCKET_ID)
    throw new StorageBucketError(
      "storage_bucket_default",
      "Save the default bucket through its storage settings in Administration > Storage.",
    );
  return id;
};
const unknown = (): never => {
  throw new StorageBucketError("storage_bucket_unknown", "Storage bucket does not exist.", 404);
};
const connected = (row: StorageBucketRow) => {
  if (row.removed_at !== null)
    throw new StorageBucketError("storage_bucket_disconnected", "Reconnect the bucket in Administration > Storage.", 409);
};
const endpoint = (value: string) => {
  if (!storageEndpointIsValid(value))
    throw new StorageBucketError(
      "storage_bucket_invalid",
      "Endpoint must be an HTTP(S) origin without credentials, path, query or fragment.",
    );
  return value;
};
const record = (db: SQL, context: StorageBucketAuditContext, action: string, id: StorageBucketId) =>
  audit.record({ ...context, action: `storage.bucket.${action}`, outcome: "allowed", target: { type: "storage_bucket", id } }, db);
const locked = async <T>(run: (tx: SQL) => Promise<T>): Promise<T> => {
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('storage.buckets', 0))`;
      return run(tx);
    });
  } catch (error) {
    if (isUniqueViolation(error, "storage_buckets_active_name"))
      throw new StorageBucketError("storage_bucket_name_taken", "A connected bucket already uses this name.", 409);
    throw error;
  }
};
const rowFor = async (db: SQL, id: StorageBucketId) => {
  const [row] = await db<StorageBucketRow[]>`SELECT * FROM platform.storage_buckets WHERE id = ${id}::uuid`;
  return row ?? unknown();
};
const effectiveSignature = async (id: StorageBucketId): Promise<string | null> => {
  try {
    return persistedSignature((await resolveObjectStoreConfig(id)).signature);
  } catch (error) {
    if (error instanceof ObjectStoreConfigurationError) return error.signature === null ? null : persistedSignature(error.signature);
    throw error;
  }
};
const list = async (): Promise<AdminStorageBucket[]> => {
  const states = await readStates(objectStoreSettingKeys);
  const text = (key: string) => {
    const value = states.get(key)?.value;
    return typeof value === "string" ? value : "";
  };
  let rows: StorageBucketRow[] = [];
  let checks: CheckRow[] = [];
  try {
    rows = await readStorageBucketRows();
    checks = await sql<CheckRow[]>`SELECT * FROM platform.storage_bucket_checks`;
  } catch (error) {
    if (!hasDatabaseErrorCode(error, ["42P01", "3F000"])) throw error;
  }
  const users = rows.some((row) => row.updated_by !== null)
    ? await sql<{ id: string; name: string }[]>`SELECT id, COALESCE(NULLIF(display_name,''),uid) AS name FROM auth.users
        WHERE id::text IN (SELECT updated_by FROM platform.storage_buckets)`
    : [];
  const defaultBucket: AdminStorageBucket = {
    id: DEFAULT_STORAGE_BUCKET_ID,
    name: "Default",
    isDefault: true,
    access: "own",
    endpoint: text("storage.endpoint"),
    region: text("storage.region"),
    bucket: text("storage.bucket"),
    hasCredentials: Boolean(text("storage.access_key_id") && text("storage.secret_access_key")),
    removedAt: null,
    check: untested(),
    revision: null,
    updatedAt: null,
    updatedBy: null,
  };
  const items = [
    defaultBucket,
    ...rows.map(
      (row): AdminStorageBucket => ({
        id: StorageBucketIdSchema.parse(row.id),
        name: row.name,
        isDefault: false,
        access: row.inherit_access ? "inherit" : "own",
        endpoint: row.endpoint,
        region: row.region,
        bucket: row.bucket,
        hasCredentials: row.credentials_encrypted !== null,
        removedAt: row.removed_at === null ? null : timestamp(row.removed_at),
        revision: row.revision,
        updatedAt: timestamp(row.updated_at),
        updatedBy: row.updated_by ? { id: row.updated_by, name: users.find((u) => u.id === row.updated_by)?.name ?? row.updated_by } : null,
        check: untested(),
      }),
    ),
  ];
  return Promise.all(
    items.map(async (item) => ({
      ...item,
      check: storageBucketCheck(
        checks.find((check) => check.bucket_id === item.id),
        await effectiveSignature(item.id),
      ),
    })),
  );
};
const get = async (value: string): Promise<AdminStorageBucket> => {
  const id = idValue(value);
  return (await list()).find((item) => item.id === id) ?? unknown();
};
const test = async (value: string, context: StorageBucketAuditContext): Promise<AdminStorageBucket> => {
  const id = idValue(value);
  // Validate lifecycle before the best-effort connection check.
  if (id !== DEFAULT_STORAGE_BUCKET_ID) connected(await rowFor(sql, id));
  let signature = "unconfigured";
  let step: StorageBucketCheckStep | null = "config";
  let ok = false;
  try {
    const backend = await objectStoreBackend(id);
    signature = backend.signature;
    try {
      await testObjectStoreBackend(backend);
      ok = true;
      step = null;
    } catch (error) {
      if (!(error instanceof ObjectStoreConnectionError)) throw error;
      step = error.step;
    }
  } catch (error) {
    if (!(error instanceof ObjectStoreConfigurationError)) throw error;
    signature = error.signature ?? "unconfigured";
  }
  await locked(async (tx) => {
    if (id !== DEFAULT_STORAGE_BUCKET_ID) connected(await rowFor(tx, id));
    await tx`INSERT INTO platform.storage_bucket_checks(bucket_id, signature, ok, step, checked_at)
      VALUES (${id}, ${persistedSignature(signature)}, ${ok}, ${step}, now()) ON CONFLICT (bucket_id) DO UPDATE
      SET signature = EXCLUDED.signature, ok = EXCLUDED.ok, step = EXCLUDED.step, checked_at = EXCLUDED.checked_at`;
    await record(tx, context, "test", id);
  });
  return get(id);
};
const create = async (value: StorageBucketCreate, context: StorageBucketAuditContext): Promise<AdminStorageBucket> => {
  const parsed = StorageBucketCreateSchema.safeParse(value);
  if (!parsed.success) throw new StorageBucketError("storage_bucket_invalid", "Invalid storage bucket configuration.");
  const input = parsed.data;
  const id = StorageBucketIdSchema.parse(crypto.randomUUID());
  const own = input.access === "own" ? input : null;
  if (own) endpoint(own.endpoint);
  const credentials = own ? await encryptValue({ accessKeyId: own.accessKeyId, secretAccessKey: own.secretAccessKey }) : null;
  await locked(async (tx) => {
    await tx`INSERT INTO platform.storage_buckets(id, name, inherit_access, endpoint, region, bucket, credentials_encrypted, updated_by)
      VALUES (${id}::uuid, ${input.name}, ${input.access === "inherit"}, ${own?.endpoint ?? null}, ${own?.region ?? null}, ${input.bucket}, ${credentials}, ${context.actor.userId ?? null})`;
    await record(tx, context, "create", id);
  });
  return test(id, context);
};
const update = async (value: string, data: StorageBucketUpdate, context: StorageBucketAuditContext): Promise<AdminStorageBucket> => {
  const id = mutableId(value);
  const parsed = StorageBucketUpdateSchema.safeParse(data);
  if (!parsed.success) throw new StorageBucketError("storage_bucket_invalid", "Invalid storage bucket configuration.");
  const input = parsed.data;
  const own = input.access === "own" ? input : null;
  if (own) endpoint(own.endpoint);
  // Shape the conflict outside the transaction to avoid resolving through another connection while holding its lock.
  const conflict = await locked(async (tx) => {
    const before = await rowFor(tx, id);
    connected(before);
    if (before.revision !== input.revision) return true;
    let credentials = before.credentials_encrypted;
    if (!own) credentials = null;
    else if (own.accessKeyId !== undefined || own.secretAccessKey !== undefined) {
      let previous: { accessKeyId: string; secretAccessKey: string } | undefined;
      if (own.accessKeyId === undefined || own.secretAccessKey === undefined) {
        if (!credentials || before.inherit_access)
          throw new StorageBucketError("storage_bucket_invalid", "Enter both keys when switching to own access.");
        try {
          previous = z.object({ accessKeyId: z.string(), secretAccessKey: z.string() }).parse(await decryptValue(credentials));
        } catch {
          throw new StorageBucketError("storage_bucket_invalid", "Stored credentials cannot be read. Enter both keys again.");
        }
      }
      credentials = await encryptValue({
        accessKeyId: own.accessKeyId ?? previous?.accessKeyId,
        secretAccessKey: own.secretAccessKey ?? previous?.secretAccessKey,
      });
    } else if (!credentials || before.inherit_access)
      throw new StorageBucketError("storage_bucket_invalid", "Enter both keys when switching to own access.");
    await tx`UPDATE platform.storage_buckets SET name = ${input.name}, inherit_access = ${input.access === "inherit"},
      endpoint = ${own?.endpoint ?? null}, region = ${own?.region ?? null}, bucket = ${input.bucket}, credentials_encrypted = ${credentials},
      revision = revision + 1, updated_at = now(), updated_by = ${context.actor.userId ?? null} WHERE id = ${id}::uuid`;
    await record(tx, context, "update", id);
    return false;
  });
  if (conflict) throw new StorageBucketError("storage_bucket_conflict", "The bucket changed. Reload before saving.", 409, await get(id));
  return test(id, context);
};
const remove = async (value: string, context: StorageBucketAuditContext): Promise<AdminStorageBucket> => {
  const id = mutableId(value);
  await locked(async (tx) => {
    connected(await rowFor(tx, id));
    await tx`UPDATE platform.storage_buckets SET removed_at = now(), credentials_encrypted = NULL,
      revision = revision + 1, updated_at = now(), updated_by = ${context.actor.userId ?? null} WHERE id = ${id}::uuid`;
    // The last test result belongs to the deleted keys; restoring tests again.
    await tx`DELETE FROM platform.storage_bucket_checks WHERE bucket_id = ${id}`;
    await record(tx, context, "remove", id);
  });
  return get(id);
};
const restore = async (value: string, data: StorageBucketRestore, context: StorageBucketAuditContext): Promise<AdminStorageBucket> => {
  const id = mutableId(value);
  const parsed = StorageBucketRestoreSchema.safeParse(data);
  if (!parsed.success) throw new StorageBucketError("storage_bucket_invalid", "Invalid storage bucket credentials.");
  await locked(async (tx) => {
    const before = await rowFor(tx, id);
    if (before.removed_at === null) throw new StorageBucketError("storage_bucket_conflict", "This bucket is already connected.", 409);
    const input = parsed.data;
    if (!before.inherit_access && (!input.accessKeyId || !input.secretAccessKey))
      throw new StorageBucketError("storage_bucket_invalid", "Enter both keys to reconnect this bucket.");
    const credentials = before.inherit_access
      ? null
      : await encryptValue({ accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey });
    await tx`UPDATE platform.storage_buckets SET removed_at = NULL, credentials_encrypted = ${credentials},
      revision = revision + 1, updated_at = now(), updated_by = ${context.actor.userId ?? null} WHERE id = ${id}::uuid`;
    await record(tx, context, "restore", id);
  });
  return test(id, context);
};
const usage = async (value: string): Promise<StorageBucketUsage> => {
  const id = idValue(value);
  if (id !== DEFAULT_STORAGE_BUCKET_ID) connected(await rowFor(sql, id));
  try {
    const { client } = await objectStoreBackend(id);
    const pages = await Promise.all(
      ["private/", "public/"].map(async (prefix) => ({ prefix, page: await client.list({ prefix, delimiter: "/", maxKeys: 1000 }) })),
    );
    const packages = new Set<string>();
    for (const { prefix, page } of pages)
      for (const entry of page.commonPrefixes ?? []) {
        const name = entry.prefix.slice(prefix.length).replace(/\/$/, "");
        if (/^[a-z][a-z0-9-]{0,79}$/.test(name)) packages.add(name);
      }
    return { packages: [...packages].sort(), truncated: pages.some(({ page }) => page.isTruncated === true) };
  } catch {
    throw new StorageBucketError(
      "storage_bucket_unreachable",
      "Storage bucket could not be reached. Test its connection in Administration > Storage.",
      502,
    );
  }
};
export const storageBucketStore = { list, get, create, update, remove, restore, test, usage };
