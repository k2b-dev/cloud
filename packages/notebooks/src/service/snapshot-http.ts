import { type ClientRequest, request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  type NetworkLookup,
  NetworkTargetBlockedError,
  type PublicNetworkAddress,
  pinnedNetworkLookup,
  resolveAllowedNetworkAddresses,
} from "@k2b/cloud/services/network-security";
import { EMPTY_NETWORK_ALLOWLIST, type NetworkAllowlist, networkAddressFamily, normalizeNetworkHostname } from "@k2b/cloud/shared";
import type { NotebookBackupConfig, NotebookBackupObject, NotebookBackupUploadResult } from "./backup";

const MAX_ERROR_BYTES = 64 * 1024;
const IDLE_TIMEOUT_MS = 60_000;
// Match the replaced Bun.S3Client default retry: 3.
const SNAPSHOT_UPLOAD_RETRIES = 3;
type RequestFactory = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export type SnapshotHttpDeps = {
  allowlist?: NetworkAllowlist;
  lookup?: NetworkLookup;
  request?: RequestFactory;
  presign?: typeof presignSnapshotObject;
  sleep?: (ms: number) => Promise<void>;
};
type SigningConfig = Pick<NotebookBackupConfig, "bucket" | "endpoint" | "region" | "accessKeyId" | "secretAccessKey">;

/** Bun signs locally; all network I/O goes through the pinned transport below. */
export const presignSnapshotObject = (config: SigningConfig, path: string): URL => {
  const client = new Bun.S3Client({
    bucket: config.bucket,
    endpoint: config.endpoint || undefined,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });
  return new URL(client.presign(path, { method: "PUT", expiresIn: 900, acl: "private" }));
};

class SnapshotUploadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const isTransientStatus = (status: number): boolean => (status >= 500 && status < 600) || status === 429 || status === 408;

const providerError = (status: number, body: Buffer): SnapshotUploadError => {
  const xml = body.toString("utf8");
  const decode = (value: string) =>
    value.replace(
      /&(?:lt|gt|amp|quot|apos);/g,
      (entity) => ({ "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" })[entity] ?? entity,
    );
  // One unambiguous capture per field keeps matching linear on malformed bodies; trim afterwards.
  const code = xml.match(/<Code>([^<]*)<\/Code>/)?.[1]?.trim();
  const message = xml.match(/<Message>([^<]*)<\/Message>/)?.[1]?.trim();
  const detail = [code, message]
    .filter((text): text is string => Boolean(text))
    .map(decode)
    .join(": ");
  return new SnapshotUploadError(`HTTP ${status}${detail ? `: ${detail}` : ""}`, isTransientStatus(status));
};

const putObject = (url: URL, object: NotebookBackupObject, addresses: PublicNetworkAddress[], deps: SnapshotHttpDeps): Promise<number> =>
  new Promise((resolve, reject) => {
    let retryable = true;
    const body = Buffer.from(object.content);
    const factory = deps.request ?? (url.protocol === "https:" ? httpsRequest : httpRequest);
    const request = factory(
      {
        protocol: url.protocol,
        hostname: normalizeNetworkHostname(url.hostname),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "PUT",
        headers: { host: url.host, "content-type": object.contentType, "content-length": String(body.length) },
        servername: networkAddressFamily(url.hostname) ? undefined : normalizeNetworkHostname(url.hostname),
        lookup: pinnedNetworkLookup(addresses),
        agent: false,
      } satisfies RequestOptions & { servername?: string },
      (response) => {
        const status = response.statusCode ?? 0;
        retryable = isTransientStatus(status);
        if (status >= 200 && status < 300) {
          // S3 answers a PUT with headers only; never wait for a body the endpoint might keep sending.
          resolve(body.length);
          response.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = () => {
          clearTimeout(deadline);
          reject(providerError(status, Buffer.concat(chunks, size)));
          response.destroy();
          request.destroy();
        };
        // An error body is only a hint: stop after 64 KiB or one idle-timeout budget, whichever comes first.
        const deadline = setTimeout(finish, IDLE_TIMEOUT_MS);
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = MAX_ERROR_BYTES - size;
          chunks.push(buffer.subarray(0, remaining));
          size += Math.min(remaining, buffer.length);
          if (size === MAX_ERROR_BYTES) finish();
        });
        response.once("end", finish);
        const failed = (error?: Error) => {
          clearTimeout(deadline);
          reject(error instanceof NetworkTargetBlockedError ? error : new SnapshotUploadError("S3 response connection failed", retryable));
        };
        response.once("error", failed);
        response.once("aborted", failed);
      },
    );
    request.setTimeout(IDLE_TIMEOUT_MS, () => request.destroy(new Error("S3 upload timed out without progress")));
    request.once("error", (error: Error) =>
      reject(
        error instanceof NetworkTargetBlockedError ? error : new SnapshotUploadError("S3 upload connection failed or timed out", retryable),
      ),
    );
    request.end(body);
  });

export const uploadSnapshotObjects = async (
  config: SigningConfig,
  objects: NotebookBackupObject[],
  deps: SnapshotHttpDeps = {},
): Promise<NotebookBackupUploadResult[]> => {
  if (!objects.length) return [];
  const presign = deps.presign ?? presignSnapshotObject;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const target = presign(config, objects[0]!.path);
  const addresses = await resolveAllowedNetworkAddresses(target.hostname, deps.allowlist ?? EMPTY_NETWORK_ALLOWLIST, deps.lookup);
  const uploaded: NotebookBackupUploadResult[] = [];
  for (const object of objects) {
    for (let attempt = 0; attempt <= SNAPSHOT_UPLOAD_RETRIES; attempt++) {
      // Sign right before each request so long uploads and retries never send an expired signature.
      const url = presign(config, object.path);
      if (url.origin !== target.origin) throw new Error("S3 upload target changed between objects");
      try {
        const bytes = await putObject(url, object, addresses, deps);
        uploaded.push({ path: object.path, bytes });
        break;
      } catch (error) {
        if (error instanceof NetworkTargetBlockedError) throw error;
        if (!(error instanceof SnapshotUploadError) || !error.retryable || attempt === SNAPSHOT_UPLOAD_RETRIES) {
          throw new Error(`Failed to upload ${object.path}. ${error instanceof SnapshotUploadError ? error.message : "S3 upload failed"}`);
        }
        await sleep(200 * 2 ** attempt);
      }
    }
  }
  return uploaded;
};
