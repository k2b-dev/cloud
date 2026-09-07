import { createHash } from "node:crypto";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import { type LogEntry, logger, get as settingsGet, settingsService } from "@valentinkolb/cloud/services";
import { parsePgJsonRecord } from "@valentinkolb/cloud/services/postgres";
import { decryptValue, encryptValue } from "@valentinkolb/cloud/services/settings/crypto";
import { sql } from "bun";
import { exportNotebookZip, type NotebookExport } from "./export";

const DEFAULT_SNAPSHOT_CRON = "0 3 * * *";
const SNAPSHOT_CRON_KEY = "notebooks.snapshot_cron";
const SNAPSHOT_LOG_SOURCE = "notebooks:snapshot:s3";

const log = logger(SNAPSHOT_LOG_SOURCE);
type SnapshotLogLevel = "info" | "error";

export type NotebookSnapshotConfig = {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  scheduleCron: string;
  accessKeyIdSet: boolean;
  secretAccessKeySet: boolean;
  configured: boolean;
  missing: string[];
  target: string | null;
};

export type UpdateNotebookSnapshotConfig = {
  enabled: boolean;
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
};

type NotebookSnapshotConfigSecret = {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  missing: string[];
  configured: boolean;
};

type SnapshotCredentials = Pick<NotebookSnapshotConfigSecret, "accessKeyId" | "secretAccessKey">;

type ResolvedSnapshotUpdate = Pick<
  NotebookSnapshotConfigSecret,
  "enabled" | "endpoint" | "region" | "bucket" | "accessKeyId" | "secretAccessKey"
>;

export type NotebookBackupPaths = {
  latestZip: string;
  snapshotZip: string;
  manifest: string;
};

export type NotebookBackupManifest = {
  format: "stuve.notebook.backup";
  version: 1;
  exportedAt: string;
  notebook: {
    id: string;
    name: string;
  };
  filename: string;
  zipBytes: number;
  sha256: string;
  paths: NotebookBackupPaths;
};

export type NotebookBackupConfig = NotebookSnapshotConfigSecret & {
  prefix: string;
};

export type NotebookBackupObject = {
  path: string;
  contentType: string;
  content: string | Uint8Array;
};

export type NotebookBackupUploadResult = {
  path: string;
  bytes: number;
};

export type NotebookBackupUploader = (
  config: NotebookBackupConfig,
  objects: NotebookBackupObject[],
) => Promise<NotebookBackupUploadResult[]>;

export type NotebookBackupRunResult = {
  message: string;
  exportedAt: string;
  filename: string;
  bytes: number;
  sha256: string;
  paths: NotebookBackupPaths;
  uploaded: NotebookBackupUploadResult[];
};

type SnapshotConfigRow = {
  notebook_short_id: string;
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
};

type EnabledNotebookRow = {
  notebook_id: string;
};

type SnapshotLogRow = {
  id: number;
  level: string;
  source: string;
  message: string;
  metadata: unknown;
  created_at: string | Date;
};

const normalizeText = (value: string | undefined | null): string => value?.trim() ?? "";

const normalizeRegion = (value: string | undefined | null): string => normalizeText(value) || "us-east-1";

const joinKey = (...parts: string[]): string =>
  parts
    .flatMap((part) => part.split("/"))
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");

const snapshotStamp = (date: Date): string => date.toISOString().replace(/[:.]/g, "-");

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const decryptString = async (encrypted: string): Promise<string> => {
  const value = await decryptValue(encrypted);
  return typeof value === "string" ? value : "";
};

const S3_PROVIDER_HINT =
  "Provider returned no detailed error message. Check that the endpoint includes the storage location, the region matches it, the bucket exists, and the access key can write objects.";

const stripHtml = (value: string): string =>
  value
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const summarizeProviderText = (value: string): string => {
  const text = value.trim();
  if (!text.startsWith("<")) return text;
  const statusMatch = text.match(/Status Code\s+(\d+)/i);
  const titleMatch = text.match(/<title>\s*([^<]+?)\s*<\/title>/i);
  const summary = [statusMatch?.[1] ? `HTTP ${statusMatch[1]}` : null, titleMatch?.[1] ? stripHtml(titleMatch[1]) : null]
    .filter(Boolean)
    .join(" ");
  return summary || stripHtml(text).slice(0, 400);
};

const describeErrorObject = (error: Error, fallback: string): string => {
  const errorText = summarizeProviderText(error.message);
  const errorName = error.name && error.name !== "Error" ? `(${error.name})` : "";
  const cause = (error as { cause?: unknown }).cause;
  const causeText = cause ? describeSnapshotError(cause, "") : "";
  const message = [errorText, errorName, causeText ? `Cause: ${causeText}` : ""].filter(Boolean).join(" ").trim();
  return !message || message === "(S3Error)" ? fallback : message;
};

const describeUnknownError = (error: unknown, fallback: string): string => {
  try {
    const json = JSON.stringify(error);
    return json && json !== "{}" ? json : fallback;
  } catch {
    const text = String(error).trim();
    return text || fallback;
  }
};

export const describeSnapshotError = (error: unknown, fallback = "Provider returned no error details."): string => {
  if (error instanceof Error) return describeErrorObject(error, fallback);
  if (typeof error === "string") return summarizeProviderText(error) || fallback;
  return describeUnknownError(error, fallback);
};

export const validateSnapshotEndpoint = (endpoint: string, region: string): Result<void> => {
  const normalized = normalizeText(endpoint);
  if (!normalized) return ok(undefined);

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return fail(err.badInput("S3 endpoint must be a valid URL, for example https://nbg1.your-objectstorage.com."));
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return fail(err.badInput("S3 endpoint must use http or https."));
  }

  if (url.hostname === "your-objectstorage.com") {
    const expectedRegion = normalizeRegion(region);
    return fail(
      err.badInput(
        `Hetzner Object Storage endpoints must include the location. Use https://${expectedRegion}.your-objectstorage.com for region ${expectedRegion}.`,
      ),
    );
  }

  return ok(undefined);
};

const getMissing = (config: Pick<NotebookSnapshotConfigSecret, "bucket" | "accessKeyId" | "secretAccessKey">): string[] =>
  [
    !config.bucket ? "bucket" : null,
    !config.accessKeyId ? "access key id" : null,
    !config.secretAccessKey ? "secret access key" : null,
  ].filter((item): item is string => item !== null);

export const getCron = async (): Promise<string> => {
  const value = String((await settingsGet<string>(SNAPSHOT_CRON_KEY)) || "").trim();
  return value.length > 0 ? value : DEFAULT_SNAPSHOT_CRON;
};

const getTimezone = async (): Promise<string> => {
  const value = String((await settingsGet<string>("app.timezone")) || "").trim();
  return value.length > 0 ? value : "Europe/Berlin";
};

const readConfigRow = async (notebookId: string): Promise<SnapshotConfigRow | null> => {
  const [row] = await sql<SnapshotConfigRow[]>`
    SELECT
      nb.short_id AS notebook_short_id,
      COALESCE(c.enabled, false) AS enabled,
      COALESCE(c.endpoint, '') AS endpoint,
      COALESCE(c.region, 'us-east-1') AS region,
      COALESCE(c.bucket, '') AS bucket,
      COALESCE(c.access_key_id, '') AS access_key_id,
      COALESCE(c.secret_access_key, '') AS secret_access_key
    FROM notebooks.notebooks nb
    LEFT JOIN notebooks.s3_snapshot_configs c ON c.notebook_id = nb.id
    WHERE nb.id = ${notebookId}::uuid
  `;
  return row ?? null;
};

const decryptRowCredentials = async (
  row: Pick<SnapshotConfigRow, "access_key_id" | "secret_access_key"> | null,
): Promise<SnapshotCredentials> => {
  const accessKeyId = row?.access_key_id ? await decryptString(row.access_key_id) : "";
  const secretAccessKey = row?.secret_access_key ? await decryptString(row.secret_access_key) : "";
  return { accessKeyId, secretAccessKey };
};

const configMissingFields = (config: Pick<NotebookSnapshotConfigSecret, "bucket"> & SnapshotCredentials): string[] => getMissing(config);

const resolveUpdateValue = (incoming: string | undefined, current: string | undefined, normalize = normalizeText): string =>
  incoming === undefined ? (current ?? "") : normalize(incoming);

const resolveSnapshotUpdate = (current: NotebookBackupConfig | null, data: UpdateNotebookSnapshotConfig): ResolvedSnapshotUpdate => ({
  enabled: data.enabled,
  endpoint: resolveUpdateValue(data.endpoint, current?.endpoint),
  region: resolveUpdateValue(data.region, current?.region ?? "us-east-1", normalizeRegion),
  bucket: resolveUpdateValue(data.bucket, current?.bucket),
  accessKeyId: resolveUpdateValue(data.accessKeyId, current?.accessKeyId),
  secretAccessKey: resolveUpdateValue(data.secretAccessKey, current?.secretAccessKey),
});

const validateResolvedSnapshotConfig = (config: ResolvedSnapshotUpdate): Result<void> => {
  if (!config.enabled) return ok(undefined);

  const missing = configMissingFields(config);
  if (missing.length > 0) return fail(err.badInput(`Missing S3 snapshot settings: ${missing.join(", ")}`));
  return validateSnapshotEndpoint(config.endpoint, config.region);
};

export const getConfig = async (params: { notebookId: string }): Promise<NotebookSnapshotConfig> => {
  const row = await readConfigRow(params.notebookId);
  const { accessKeyId, secretAccessKey } = await decryptRowCredentials(row);
  const bucket = normalizeText(row?.bucket);
  const missing = configMissingFields({ bucket, accessKeyId, secretAccessKey });
  const enabled = row?.enabled ?? false;
  const scheduleCron = await getCron();

  return {
    enabled,
    endpoint: normalizeText(row?.endpoint),
    region: normalizeRegion(row?.region),
    bucket,
    scheduleCron,
    accessKeyIdSet: accessKeyId.length > 0,
    secretAccessKeySet: secretAccessKey.length > 0,
    configured: enabled && missing.length === 0,
    missing,
    target: bucket ? joinKey(bucket, "notebooks", row?.notebook_short_id ?? params.notebookId) : null,
  };
};

const readConfigSecret = async (notebookId: string): Promise<NotebookBackupConfig | null> => {
  const row = await readConfigRow(notebookId);
  if (!row) return null;

  const { accessKeyId, secretAccessKey } = await decryptRowCredentials(row);
  const config: NotebookBackupConfig = {
    enabled: row.enabled,
    endpoint: normalizeText(row.endpoint),
    region: normalizeRegion(row.region),
    bucket: normalizeText(row.bucket),
    prefix: "notebooks",
    accessKeyId,
    secretAccessKey,
    missing: [],
    configured: false,
  };
  config.missing = getMissing(config);
  config.configured = config.enabled && config.missing.length === 0;
  return config;
};

const persistSnapshotConfig = async (params: { notebookId: string; userId: string; config: ResolvedSnapshotUpdate }): Promise<void> => {
  const [encryptedAccessKeyId, encryptedSecretAccessKey] = await Promise.all([
    encryptValue(params.config.accessKeyId),
    encryptValue(params.config.secretAccessKey),
  ]);

  await sql`
    INSERT INTO notebooks.s3_snapshot_configs (
      notebook_id,
      enabled,
      endpoint,
      region,
      bucket,
      access_key_id,
      secret_access_key,
      updated_by,
      updated_at
    )
    VALUES (
      ${params.notebookId}::uuid,
      ${params.config.enabled},
      ${params.config.endpoint},
      ${params.config.region},
      ${params.config.bucket},
      ${encryptedAccessKeyId},
      ${encryptedSecretAccessKey},
      ${params.userId}::uuid,
      now()
    )
    ON CONFLICT (notebook_id)
    DO UPDATE SET
      enabled = EXCLUDED.enabled,
      endpoint = EXCLUDED.endpoint,
      region = EXCLUDED.region,
      bucket = EXCLUDED.bucket,
      access_key_id = EXCLUDED.access_key_id,
      secret_access_key = EXCLUDED.secret_access_key,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
  `;
};

export const updateConfig = async (params: {
  notebookId: string;
  userId: string;
  data: UpdateNotebookSnapshotConfig;
}): Promise<Result<NotebookSnapshotConfig>> => {
  const current = await readConfigSecret(params.notebookId);
  const next = resolveSnapshotUpdate(current, params.data);
  const validation = validateResolvedSnapshotConfig(next);
  if (!validation.ok) return fail(validation.error);

  await persistSnapshotConfig({ notebookId: params.notebookId, userId: params.userId, config: next });
  return ok(await getConfig({ notebookId: params.notebookId }));
};

export const updateCron = async (cron: string): Promise<Result<{ cron: string }>> => {
  const normalized = cron.trim();
  if (!normalized) return fail(err.badInput("Snapshot cron must not be empty."));
  const saved = await settingsService.entry.update({ key: SNAPSHOT_CRON_KEY, value: normalized });
  if (!saved.ok) return fail(saved.error);
  await snapshotRuntime.reschedule(normalized);
  log.info("Snapshot cron updated", { cron: normalized });
  return ok({ cron: normalized });
};

const mapSnapshotLogRow = (row: SnapshotLogRow): LogEntry => ({
  id: String(row.id),
  level: row.level as LogEntry["level"],
  source: row.source,
  message: row.message,
  metadata: parsePgJsonRecord(row.metadata),
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
});

export const listLogs = async (params: { notebookId: string; limit?: number }): Promise<LogEntry[]> => {
  const perPage = Math.min(Math.max(params.limit ?? 10, 1), 50);
  const rows = await sql<SnapshotLogRow[]>`
    WITH snapshot_logs AS (
      SELECT
        id,
        level,
        source,
        message,
        metadata,
        created_at,
        CASE
          WHEN jsonb_typeof(metadata) = 'object' THEN metadata->>'notebookId'
          WHEN jsonb_typeof(metadata) = 'string' THEN ((metadata #>> '{}')::jsonb)->>'notebookId'
          ELSE NULL
        END AS notebook_id
      FROM logging.entries
      WHERE source = ${SNAPSHOT_LOG_SOURCE}
    )
    SELECT id, level, source, message, metadata, created_at
    FROM snapshot_logs
    WHERE notebook_id = ${params.notebookId}
      AND (
        message = 'Notebook S3 snapshot uploaded'
        OR message = 'Notebook S3 snapshot upload failed'
      )
    ORDER BY created_at DESC
    LIMIT ${perPage}
  `;
  return rows.map(mapSnapshotLogRow);
};

const writeSnapshotRunLog = async (level: SnapshotLogLevel, message: string, metadata: Record<string, unknown>): Promise<void> => {
  const consoleFn = level === "error" ? console.error : console.log;
  consoleFn(`[${SNAPSHOT_LOG_SOURCE}]`, message, metadata);
  await sql`
    INSERT INTO logging.entries (level, source, message, metadata)
    VALUES (
      ${level},
      ${SNAPSHOT_LOG_SOURCE},
      ${message},
      (${JSON.stringify(metadata)}::text)::jsonb
    )
  `;
};

const writeSnapshotRunLogBestEffort = async (
  level: SnapshotLogLevel,
  message: string,
  metadata: Record<string, unknown>,
): Promise<void> => {
  try {
    await writeSnapshotRunLog(level, message, metadata);
  } catch (error) {
    console.error(`[${SNAPSHOT_LOG_SOURCE}] Failed to persist snapshot run log:`, error instanceof Error ? error.message : String(error));
  }
};

export const buildNotebookBackupPaths = (
  config: Pick<NotebookBackupConfig, "prefix">,
  params: {
    notebookShortId: string;
    exportedAt: Date;
  },
): NotebookBackupPaths => {
  const base = joinKey(config.prefix || "notebooks", params.notebookShortId);
  return {
    latestZip: joinKey(base, "latest.zip"),
    snapshotZip: joinKey(base, "snapshots", `${snapshotStamp(params.exportedAt)}.zip`),
    manifest: joinKey(base, "latest-manifest.json"),
  };
};

export const createNotebookBackupManifest = (params: {
  exported: NotebookExport;
  exportedAt: Date;
  paths: NotebookBackupPaths;
}): NotebookBackupManifest => ({
  format: "stuve.notebook.backup",
  version: 1,
  exportedAt: params.exportedAt.toISOString(),
  notebook: {
    id: params.exported.notebook.id,
    name: params.exported.notebook.name,
  },
  filename: params.exported.filename,
  zipBytes: params.exported.zip.byteLength,
  sha256: sha256(params.exported.zip),
  paths: params.paths,
});

export const defaultS3Uploader: NotebookBackupUploader = async (config, objects) => {
  const client = new Bun.S3Client({
    bucket: config.bucket,
    endpoint: config.endpoint || undefined,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });

  const uploaded: NotebookBackupUploadResult[] = [];
  for (const object of objects) {
    try {
      const bytes = await client.write(object.path, object.content, {
        type: object.contentType,
        acl: "private",
      });
      uploaded.push({ path: object.path, bytes });
    } catch (error) {
      const endpoint = config.endpoint || "provider default endpoint";
      throw new Error(
        `Failed to upload ${object.path} to bucket ${config.bucket} (${endpoint}, region ${config.region}). ${describeSnapshotError(
          error,
          S3_PROVIDER_HINT,
        )}`,
      );
    }
  }
  return uploaded;
};

export const runNotebookS3Backup = async (params: {
  notebookId: string;
  uploader?: NotebookBackupUploader;
  exportedAt?: Date;
  trigger?: "manual" | "scheduler";
}): Promise<Result<NotebookBackupRunResult>> => {
  const config = await readConfigSecret(params.notebookId);
  if (!config?.enabled) return fail(err.badInput("S3 notebook snapshots are disabled."));
  if (!config.configured) return fail(err.badInput(`Missing S3 snapshot settings: ${config.missing.join(", ")}`));
  const endpointValidation = validateSnapshotEndpoint(config.endpoint, config.region);
  if (!endpointValidation.ok) return fail(endpointValidation.error);

  const exportedAt = params.exportedAt ?? new Date();
  const exported = await exportNotebookZip({ notebookId: params.notebookId, exportedAt });
  if (!exported) return fail(err.notFound("Notebook"));

  const paths = buildNotebookBackupPaths(config, { notebookShortId: exported.notebook.id, exportedAt });
  const manifest = createNotebookBackupManifest({ exported, exportedAt, paths });
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const objects: NotebookBackupObject[] = [
    { path: paths.latestZip, contentType: "application/zip", content: exported.zip },
    { path: paths.snapshotZip, contentType: "application/zip", content: exported.zip },
    { path: paths.manifest, contentType: "application/json", content: manifestJson },
  ];

  try {
    const uploaded = await (params.uploader ?? defaultS3Uploader)(config, objects);
    await writeSnapshotRunLogBestEffort("info", "Notebook S3 snapshot uploaded", {
      trigger: params.trigger ?? "manual",
      notebookId: params.notebookId,
      notebookShortId: exported.notebook.id,
      bucket: config.bucket,
      bytes: exported.zip.byteLength,
      sha256: manifest.sha256,
      latestZip: paths.latestZip,
      snapshotZip: paths.snapshotZip,
    });
    return ok({
      message: "Notebook S3 snapshot uploaded",
      exportedAt: exportedAt.toISOString(),
      filename: exported.filename,
      bytes: exported.zip.byteLength,
      sha256: manifest.sha256,
      paths,
      uploaded,
    });
  } catch (error) {
    const detail = describeSnapshotError(error, S3_PROVIDER_HINT);
    await writeSnapshotRunLogBestEffort("error", "Notebook S3 snapshot upload failed", {
      trigger: params.trigger ?? "manual",
      notebookId: params.notebookId,
      notebookShortId: exported.notebook.id,
      bucket: config.bucket,
      endpoint: config.endpoint,
      region: config.region,
      latestZip: paths.latestZip,
      error: detail,
    });
    return fail(err.internal(`S3 snapshot upload failed. ${detail}`));
  }
};

const listEnabledNotebookIds = async (): Promise<string[]> => {
  const rows = await sql<EnabledNotebookRow[]>`
    SELECT notebook_id
    FROM notebooks.s3_snapshot_configs
    WHERE enabled = true
  `;
  return rows.map((row) => row.notebook_id);
};

const runScheduledSnapshots = async (onProgress?: () => Promise<void>): Promise<void> => {
  const notebookIds = await listEnabledNotebookIds();
  log.info("Scheduled S3 snapshots started", { notebooks: notebookIds.length });
  let succeeded = 0;
  let failed = 0;
  for (const notebookId of notebookIds) {
    const result = await runNotebookS3Backup({ notebookId, trigger: "scheduler" });
    if (result.ok) succeeded += 1;
    else failed += 1;
    await onProgress?.();
  }
  log.info("Scheduled S3 snapshots finished", { notebooks: notebookIds.length, succeeded, failed });
};

const snapshotJob = lazySync((sync) =>
  sync.job<null>({
    id: "notebooks:snapshot:s3",
    delivery: { ackWaitMs: 900_000, maxInFlight: 1, maxAttempts: 3, backoffMs: [10_000, 20_000] },
  }),
);
const snapshotScheduler = lazySync((sync) => sync.scheduler({ id: "notebooks:snapshot:s3" }));
let jobWorker: Worker | undefined;
let scheduleWorker: Worker | undefined;

const startWorkers = async (): Promise<void> => {
  jobWorker ??= await snapshotJob().process({}, async (ctx) => {
    ctx.signal.throwIfAborted();
    await runScheduledSnapshots(async () => {
      ctx.signal.throwIfAborted();
      await ctx.heartbeat();
    });
  });
  scheduleWorker ??= await snapshotScheduler().process({});
};

let started = false;
let registered = false;
let registerPromise: Promise<void> | null = null;

const createSchedule = async (cron: string, tz: string): Promise<void> => {
  await snapshotScheduler().create({
    id: "notebooks:snapshot:s3",
    cron,
    timezone: tz,
    meta: {
      appId: "notebooks",
      family: "notebooks:snapshots",
      label: "Notebook S3 snapshot",
      source: SNAPSHOT_LOG_SOURCE,
    },
    process: async (ctx) => {
      await snapshotJob().submit({ key: ctx.runId, input: null });
    },
  });
  log.info("S3 snapshot schedule registered", { cron, tz });
};

const registerSchedule = async (cron?: string): Promise<void> => {
  const [tz, resolvedCron] = await Promise.all([getTimezone(), cron ? Promise.resolve(cron) : getCron()]);
  try {
    await createSchedule(resolvedCron, tz);
    registered = true;
  } catch (error) {
    if (!cron && resolvedCron !== DEFAULT_SNAPSHOT_CRON) {
      log.warn("Invalid configured S3 snapshot cron, falling back to default", {
        configuredCron: resolvedCron,
        fallbackCron: DEFAULT_SNAPSHOT_CRON,
        timezone: tz,
        error: error instanceof Error ? error.message : String(error),
      });
      await createSchedule(DEFAULT_SNAPSHOT_CRON, tz);
      registered = true;
      return;
    }
    throw error;
  }
};

const ensureRegistered = async (): Promise<void> => {
  if (registered) return;
  if (!registerPromise) {
    registerPromise = registerSchedule().finally(() => {
      registerPromise = null;
    });
  }
  await registerPromise;
};

export const snapshotRuntime = {
  start: async (): Promise<void> => {
    if (!started) {
      await ensureRegistered();
      await startWorkers();
      started = true;
    }
    await ensureRegistered();
  },

  stop: async (): Promise<void> => {
    scheduleWorker?.stop();
    jobWorker?.stop();
    await Promise.all([scheduleWorker?.drain(), jobWorker?.drain()]);
    scheduleWorker = undefined;
    jobWorker = undefined;
    started = false;
    registered = false;
    registerPromise = null;
  },

  reschedule: async (cron: string): Promise<void> => {
    const normalized = cron.trim();
    if (!normalized) throw new Error("Snapshot cron must not be empty.");
    if (!started) {
      await ensureRegistered();
      await startWorkers();
      started = true;
    }
    await registerSchedule(normalized);
  },

  getCron,
};
