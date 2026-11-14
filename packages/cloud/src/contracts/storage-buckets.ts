import { z } from "zod";

/**
 * Storage buckets: the default bucket from the storage settings and the further buckets an administrator connects.
 * Browser-safe; the server and the administration share these shapes.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The stable reference to one bucket. It never changes, also when the administrator renames the bucket or changes its
 * endpoint, bucket or keys. Applications store only this ID. The default bucket's ID is `"default"`; every further
 * bucket has a UUID.
 */
export const StorageBucketIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => value === "default" || UUID.test(value), { message: "Invalid storage bucket ID." })
  .brand<"StorageBucketId">();
export type StorageBucketId = z.infer<typeof StorageBucketIdSchema>;

/** The ID of the default bucket that the storage settings configure. */
export const DEFAULT_STORAGE_BUCKET_ID: StorageBucketId = StorageBucketIdSchema.parse("default");

/** A stored string as a bucket ID, or `null` when it is not one. Checks the form only, not that the bucket exists. */
export const parseStorageBucketId = (value: unknown): StorageBucketId | null => {
  const result = StorageBucketIdSchema.safeParse(value);
  return result.success ? result.data : null;
};

/** The name administrators and application settings show. It may change at any time; it is never a reference. */
export const StorageBucketNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((value) => !/\p{Cc}/u.test(value), { message: "Name must not contain control characters." });

/** One bucket as applications see it: no endpoint, bucket name or keys. */
export const StorageBucketSummarySchema = z.object({
  id: StorageBucketIdSchema,
  name: z.string(),
  isDefault: z.boolean(),
  /** False after an administrator disconnected the bucket; operations then fail with `storage_bucket_disconnected`. */
  connected: z.boolean(),
});
export type StorageBucketSummary = z.infer<typeof StorageBucketSummarySchema>;

/** S3 bucket names as Garage and S3 accept them. */
export const S3BucketNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, { message: "Use 3–63 lowercase letters, digits, dots and hyphens." });

/** `inherit`: the default bucket's endpoint, region and keys, with a bucket of its own. `own`: everything its own. */
export const StorageBucketAccessSchema = z.enum(["inherit", "own"]);
export type StorageBucketAccess = z.infer<typeof StorageBucketAccessSchema>;

/** Where a connection test stopped. `config` means the saved configuration is incomplete or unreadable. */
export const StorageBucketCheckStepSchema = z.enum(["config", "write", "read", "delete"]);
export type StorageBucketCheckStep = z.infer<typeof StorageBucketCheckStepSchema>;

/**
 * The last connection test. It counts only for the configuration it tested: after any change of endpoint, region,
 * bucket or keys (also inherited ones), the state is `untested` again.
 */
export const StorageBucketCheckSchema = z.object({
  state: z.enum(["untested", "ok", "failed"]),
  step: StorageBucketCheckStepSchema.nullable(),
  checkedAt: z.string().nullable(),
});
export type StorageBucketCheck = z.infer<typeof StorageBucketCheckSchema>;

/** One bucket in the administration. Keys are never returned, only whether they are stored. */
export const AdminStorageBucketSchema = z.object({
  id: StorageBucketIdSchema,
  name: z.string(),
  isDefault: z.boolean(),
  access: StorageBucketAccessSchema,
  /** The own endpoint; `null` for `inherit`. The default bucket shows its setting. */
  endpoint: z.string().nullable(),
  region: z.string().nullable(),
  bucket: z.string(),
  hasCredentials: z.boolean(),
  removedAt: z.string().nullable(),
  check: StorageBucketCheckSchema,
  /** Optimistic version for updates; `null` for the default bucket, which saves through the storage settings. */
  revision: z.number().int().min(1).nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type AdminStorageBucket = z.infer<typeof AdminStorageBucketSchema>;

const Endpoint = z.string().trim().min(1).max(2048);
const Region = z.string().trim().min(1).max(64);
const AccessKeyId = z.string().trim().min(1).max(256);
const SecretAccessKey = z.string().min(1).max(512);

/** Create a bucket. `own` needs both keys. */
export const StorageBucketCreateSchema = z.discriminatedUnion("access", [
  z.object({ access: z.literal("inherit"), name: StorageBucketNameSchema, bucket: S3BucketNameSchema }),
  z.object({
    access: z.literal("own"),
    name: StorageBucketNameSchema,
    endpoint: Endpoint,
    region: Region,
    bucket: S3BucketNameSchema,
    accessKeyId: AccessKeyId,
    secretAccessKey: SecretAccessKey,
  }),
]);
export type StorageBucketCreate = z.infer<typeof StorageBucketCreateSchema>;

/**
 * Change a bucket at the revision the administrator saw. For `own`, omitted keys keep the stored ones; switching from
 * `inherit` to `own` needs both keys.
 */
export const StorageBucketUpdateSchema = z.discriminatedUnion("access", [
  z.object({
    access: z.literal("inherit"),
    revision: z.number().int().min(1),
    name: StorageBucketNameSchema,
    bucket: S3BucketNameSchema,
  }),
  z.object({
    access: z.literal("own"),
    revision: z.number().int().min(1),
    name: StorageBucketNameSchema,
    endpoint: Endpoint,
    region: Region,
    bucket: S3BucketNameSchema,
    accessKeyId: AccessKeyId.optional(),
    secretAccessKey: SecretAccessKey.optional(),
  }),
]);
export type StorageBucketUpdate = z.infer<typeof StorageBucketUpdateSchema>;

/** Reconnect a disconnected bucket to its last target. `own` buckets need their keys again. */
export const StorageBucketRestoreSchema = z.object({
  accessKeyId: AccessKeyId.optional(),
  secretAccessKey: SecretAccessKey.optional(),
});
export type StorageBucketRestore = z.infer<typeof StorageBucketRestoreSchema>;

/** Application areas (packages) with objects in a bucket, read from the bucket itself. */
export const StorageBucketUsageSchema = z.object({
  packages: z.array(z.string()),
  /** More areas exist than one listing page returned. */
  truncated: z.boolean(),
});
export type StorageBucketUsage = z.infer<typeof StorageBucketUsageSchema>;

export const STORAGE_BUCKET_ERROR_CODES = [
  "storage_bucket_invalid",
  "storage_bucket_unknown",
  "storage_bucket_disconnected",
  "storage_bucket_conflict",
  "storage_bucket_name_taken",
  "storage_bucket_default",
  "storage_bucket_unreachable",
] as const;
export type StorageBucketErrorCode = (typeof STORAGE_BUCKET_ERROR_CODES)[number];

/** Error body of the administration API. A conflict carries the current bucket. */
export const StorageBucketErrorSchema = z.object({
  code: z.enum(STORAGE_BUCKET_ERROR_CODES),
  message: z.string(),
  current: AdminStorageBucketSchema.optional(),
});
export type StorageBucketError = z.infer<typeof StorageBucketErrorSchema>;
