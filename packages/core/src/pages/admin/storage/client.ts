import { coreClient } from "@k2b/cloud/clients/core";
import {
  type AdminStorageBucket,
  AdminStorageBucketSchema,
  type StorageBucketErrorCode,
  StorageBucketErrorSchema,
} from "@k2b/cloud/contracts/storage-buckets";
import { z } from "zod";

export const storageAdminApi = coreClient.admin.core.storage;

/** A failed administration call with the server's code; a conflict carries the stored bucket. */
export class StorageAdminError extends Error {
  constructor(
    message: string,
    readonly code: StorageBucketErrorCode | null,
    readonly current: AdminStorageBucket | null = null,
  ) {
    super(message);
  }
}

const BucketAnswer = z.object({ bucket: AdminStorageBucketSchema });

/** The answer's JSON checked against `schema`, or a `StorageAdminError` with the server's message and code. */
export const readStorageAdmin = async <T>(
  response: { ok: boolean; json(): Promise<unknown> },
  schema: z.ZodType<T>,
  fallback: string,
): Promise<T> => {
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    throw new StorageAdminError(fallback, null);
  }
  const failure = StorageBucketErrorSchema.safeParse(body);
  if (failure.success) throw new StorageAdminError(failure.data.message, failure.data.code, failure.data.current ?? null);
  throw new StorageAdminError(fallback, null);
};

/** An answer that returns the changed bucket. */
export const readBucket = async (response: { ok: boolean; json(): Promise<unknown> }, fallback: string): Promise<AdminStorageBucket> =>
  (await readStorageAdmin(response, BucketAnswer, fallback)).bucket;
