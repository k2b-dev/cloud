import { createHash, createHmac } from "node:crypto";
import { S3Client } from "bun";
import { z } from "zod";
import { DEFAULT_STORAGE_BUCKET_ID, type StorageBucketCheckStep, type StorageBucketId } from "../contracts/storage-buckets";
import { sql } from "../runtime/clients";
import { decryptValue, getAppSecret } from "../services/settings/crypto";
import { readStates } from "../services/settings/store";
import { bucketTableUnavailable, type StorageBucketRow } from "../services/storage-buckets/rows";

export const objectStoreSettingKeys = [
  "storage.endpoint",
  "storage.region",
  "storage.bucket",
  "storage.access_key_id",
  "storage.secret_access_key",
  "storage.max_object_bytes",
] as const;
const Config = z.object({
  endpoint: z.string().min(1),
  region: z.string().min(1),
  bucket: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  access_key_id: z.string().min(1),
  secret_access_key: z.string().min(1),
  max_object_bytes: z
    .number()
    .int()
    .min(1)
    .max(5 * 1024 ** 3),
});
const Credentials = z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) });
export type ObjectStoreErrorCode =
  | "storage_bucket_invalid"
  | "storage_bucket_unknown"
  | "storage_bucket_disconnected"
  | "storage_not_configured"
  | "storage_unreadable";
export class ObjectStoreConfigurationError extends Error {
  readonly step = "config";
  signature: string | null = null;
  constructor(
    message: string,
    public readonly code: ObjectStoreErrorCode = "storage_not_configured",
  ) {
    super(message);
  }
}
export class ObjectStoreConnectionError extends Error {
  constructor(
    message: string,
    public readonly step: StorageBucketCheckStep = "config",
  ) {
    super(message);
  }
}
const cached = new Map<StorageBucketId, { signature: string; client: S3Client }>();

/** Identifies one effective configuration, keys included. Stays in memory; storage keys it first (`persistedSignature`). */
const configSignature = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * The form of a signature that may be stored. Keyed with APP_SECRET, so a signature in a database dump never lets
 * anyone confirm a guessed key offline.
 */
export const persistedSignature = (signature: string): string =>
  createHmac("sha256", `cloud.storage-bucket-check:${getAppSecret()}`).update(signature).digest("hex");

export const storageEndpointIsValid = (value: string): boolean => {
  const endpoint = URL.parse(value);
  return Boolean(
    endpoint &&
      ["http:", "https:"].includes(endpoint.protocol) &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash &&
      endpoint.pathname === "/",
  );
};
const unreadable = () =>
  new ObjectStoreConfigurationError(
    "Storage credentials cannot be decrypted. Check this process uses the installation APP_SECRET, then reconnect the bucket in Administration > Storage.",
    "storage_unreadable",
  );
const notConfigured = () =>
  new ObjectStoreConfigurationError(
    "Storage is not configured. Connect it in Administration > Storage and check this process has database read access.",
  );

/** Read row and inherited settings in one repeatable-read snapshot; never use a process TTL. */
export const resolveObjectStoreConfig = async (id: StorageBucketId = DEFAULT_STORAGE_BUCKET_ID) => {
  const read = async (db: typeof sql, row?: StorageBucketRow) => {
    const keys = row
      ? row.inherit_access
        ? objectStoreSettingKeys.filter((key) => key !== "storage.bucket")
        : ["storage.max_object_bytes"]
      : objectStoreSettingKeys;
    const states = await readStates(keys, db);
    const values: Record<string, unknown> = Object.fromEntries(keys.map((key) => [key.slice("storage.".length), states.get(key)?.value]));
    const failureSignature = configSignature({
      values,
      credentials: row?.credentials_encrypted,
      states: [...states].map(([key, state]) => [key, state.stored]),
    });
    const failure = (error: ObjectStoreConfigurationError) => Object.assign(error, { signature: failureSignature });
    if (keys.some((key) => states.get(key)?.stored === "unreadable")) throw failure(unreadable());
    if (row) {
      values.bucket = row.bucket;
      if (!row.inherit_access) {
        values.endpoint = row.endpoint;
        values.region = row.region;
        let credentials: z.infer<typeof Credentials>;
        try {
          credentials = Credentials.parse(await decryptValue(row.credentials_encrypted ?? ""));
        } catch {
          if (row.credentials_encrypted === null) throw failure(notConfigured());
          throw failure(unreadable());
        }
        values.access_key_id = credentials.accessKeyId;
        values.secret_access_key = credentials.secretAccessKey;
      }
    }
    const parsed = Config.safeParse(values);
    if (!parsed.success) throw failure(notConfigured());
    if (!storageEndpointIsValid(parsed.data.endpoint))
      throw failure(
        new ObjectStoreConfigurationError(
          "Storage endpoint must be an HTTP(S) origin without credentials, path, query or fragment. Correct it in Administration > Storage.",
        ),
      );
    return parsed.data;
  };
  try {
    const config =
      id === DEFAULT_STORAGE_BUCKET_ID
        ? await read(sql)
        : await sql.begin(async (tx) => {
            await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
            const [row] = await tx<StorageBucketRow[]>`SELECT * FROM platform.storage_buckets WHERE id = ${id}::uuid`;
            if (!row)
              throw new ObjectStoreConfigurationError(
                "Storage bucket is unknown. Connect it in Administration > Storage.",
                "storage_bucket_unknown",
              );
            if (row.removed_at !== null)
              throw new ObjectStoreConfigurationError(
                "Storage bucket is disconnected. Reconnect it in Administration > Storage.",
                "storage_bucket_disconnected",
              );
            return read(tx, row);
          });
    const signature = configSignature(config);
    return { config, signature };
  } catch (error) {
    if (error instanceof ObjectStoreConfigurationError) throw error;
    if (bucketTableUnavailable(error)) throw notConfigured();
    throw new ObjectStoreConfigurationError(
      "Storage configuration could not be read. Check database access and reconnect it in Administration > Storage.",
      "storage_unreadable",
    );
  }
};

export const objectStoreBackend = async (id: StorageBucketId = DEFAULT_STORAGE_BUCKET_ID) => {
  const { config, signature } = await resolveObjectStoreConfig(id);
  let backend = cached.get(id);
  if (backend?.signature !== signature) {
    backend = {
      signature,
      client: new S3Client({
        endpoint: new URL(config.endpoint).href,
        region: config.region,
        bucket: config.bucket,
        accessKeyId: config.access_key_id,
        secretAccessKey: config.secret_access_key,
      }),
    };
    cached.set(id, backend);
  }
  return { client: backend.client, limit: config.max_object_bytes, signature };
};

/** Test exactly this resolved client so concurrent edits cannot label a different configuration as tested. */
export const testObjectStoreBackend = async (backend: Awaited<ReturnType<typeof objectStoreBackend>>): Promise<void> => {
  const file = backend.client.file(`cloud-connection-test/${crypto.randomUUID()}`);
  const content = "Cloud storage connection test";
  let step: StorageBucketCheckStep = "write";
  try {
    await file.write(content, { type: "text/plain" });
    step = "read";
    if ((await file.text()) !== content) throw new Error("Unexpected content");
    step = "delete";
    await file.delete();
    if (await file.exists()) throw new Error("Object still exists");
  } catch {
    try {
      await file.delete();
    } catch {
      throw new ObjectStoreConnectionError(
        `Storage test failed at ${step}; cleanup failed. Remove cloud-connection-test/ objects after fixing the connection.`,
        step,
      );
    }
    throw new ObjectStoreConnectionError(
      `Storage test failed at ${step}. Check the saved configuration, service availability and bucket permissions, then retry.`,
      step,
    );
  }
};
export const testObjectStoreConnection = async (id: StorageBucketId = DEFAULT_STORAGE_BUCKET_ID): Promise<void> =>
  testObjectStoreBackend(await objectStoreBackend(id));
