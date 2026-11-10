import type { SQL } from "bun";
import { DEFAULT_STORAGE_BUCKET_ID, StorageBucketIdSchema, type StorageBucketSummary } from "../../contracts/storage-buckets";
import { sql } from "../../runtime/clients";

export type StorageBucketRow = {
  id: string;
  name: string;
  inherit_access: boolean;
  endpoint: string | null;
  region: string | null;
  bucket: string;
  credentials_encrypted: string | null;
  removed_at: Date | string | null;
  revision: number;
  updated_at: Date | string;
  updated_by: string | null;
};

export const hasDatabaseErrorCode = (error: unknown, codes: readonly string[]): boolean =>
  error !== null &&
  typeof error === "object" &&
  (("code" in error && typeof error.code === "string" && codes.includes(error.code)) ||
    ("errno" in error && typeof error.errno === "string" && codes.includes(error.errno)));

export const readStorageBucketRows = (db: SQL = sql): Promise<StorageBucketRow[]> =>
  db<StorageBucketRow[]>`SELECT id, name, inherit_access, endpoint, region, bucket, credentials_encrypted,
    removed_at, revision, updated_at, updated_by FROM platform.storage_buckets
    ORDER BY (removed_at IS NOT NULL), lower(name), id`;

export const listStorageBuckets = async (): Promise<StorageBucketSummary[]> => {
  let rows: StorageBucketRow[];
  try {
    rows = await readStorageBucketRows();
  } catch (error) {
    if (!hasDatabaseErrorCode(error, ["42P01", "3F000"])) throw new Error("Storage buckets could not be read. Check database access.");
    rows = [];
  }
  return [
    { id: DEFAULT_STORAGE_BUCKET_ID, name: "Default", isDefault: true, connected: true },
    ...rows.map((row) => ({
      id: StorageBucketIdSchema.parse(row.id),
      name: row.name,
      isDefault: false,
      connected: row.removed_at === null,
    })),
  ];
};
