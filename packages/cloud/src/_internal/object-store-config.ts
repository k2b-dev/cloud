import { S3Client } from "bun";
import { z } from "zod";
import { readStates } from "../services/settings/store";

export const objectStoreSettingKeys = [
  "storage.endpoint",
  "storage.region",
  "storage.bucket",
  "storage.access_key_id",
  "storage.secret_access_key",
  "storage.max_object_bytes",
] as const;
const bucket = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/);
const Config = z.object({
  endpoint: z.string().min(1),
  region: z.string().min(1),
  bucket,
  access_key_id: z.string().min(1),
  secret_access_key: z.string().min(1),
  max_object_bytes: z
    .number()
    .int()
    .min(1)
    .max(5 * 1024 ** 3),
});
export class ObjectStoreConfigurationError extends Error {}
export class ObjectStoreConnectionError extends Error {}
let cached: { signature: string; client: S3Client } | undefined;

export const objectStoreBackend = async () => {
  // Read one coherent DB snapshot, including stored-state checks. No local TTL:
  // changes and secret rotation apply to the next operation in every process.
  const states = await readStates(objectStoreSettingKeys);
  if (objectStoreSettingKeys.some((key) => states.get(key)?.stored === "unreadable")) {
    throw new ObjectStoreConfigurationError(
      "Storage settings cannot be decrypted. Check this process uses the installation APP_SECRET, then replace unreadable settings in Administration > Settings > Storage.",
    );
  }
  const parsed = Config.safeParse(
    Object.fromEntries(objectStoreSettingKeys.map((key) => [key.slice("storage.".length), states.get(key)?.value])),
  );
  if (!parsed.success)
    throw new ObjectStoreConfigurationError(
      "Storage is not configured. Set the Garage endpoint, region, bucket and credentials in Administration > Settings > Storage.",
    );
  const config = parsed.data;
  const endpoint = URL.parse(config.endpoint);
  if (
    !endpoint ||
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  ) {
    throw new ObjectStoreConfigurationError("Storage endpoint must be an HTTP(S) origin without credentials, path, query or fragment.");
  }
  const signature = JSON.stringify(config);
  if (cached?.signature !== signature) {
    const options = {
      endpoint: endpoint.href,
      accessKeyId: config.access_key_id,
      secretAccessKey: config.secret_access_key,
      region: config.region,
    };
    cached = { signature, client: new S3Client({ ...options, bucket: config.bucket }) };
  }
  return { client: cached.client, limit: config.max_object_bytes };
};

/** Internal administrator check; never an application API or a credential response. */
export const testObjectStoreConnection = async (): Promise<void> => {
  const backend = await objectStoreBackend();
  const file = backend.client.file(`cloud-connection-test/${crypto.randomUUID()}`);
  const content = "Cloud storage connection test";
  let step = "write";
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
      );
    }
    throw new ObjectStoreConnectionError(
      `Storage test failed at ${step}. Check the saved settings, Garage availability and bucket permissions, then retry.`,
    );
  }
};
