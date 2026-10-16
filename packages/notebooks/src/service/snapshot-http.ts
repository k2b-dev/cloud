import { type ClientRequest, request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  type NetworkLookup,
  type PublicNetworkAddress,
  pinnedNetworkLookup,
  resolveAllowedNetworkAddresses,
} from "@k2b/cloud/services/network-security";
import { EMPTY_NETWORK_ALLOWLIST, type NetworkAllowlist, networkAddressFamily, normalizeNetworkHostname } from "@k2b/cloud/shared";
import type { NotebookBackupConfig, NotebookBackupObject, NotebookBackupUploadResult } from "./backup";

const MAX_ERROR_BYTES = 64 * 1024;
type RequestFactory = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export type SnapshotHttpDeps = {
  allowlist?: NetworkAllowlist;
  lookup?: NetworkLookup;
  request?: RequestFactory;
  presign?: typeof presignSnapshotObject;
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

const providerError = (status: number, body: Buffer): Error => {
  const xml = body.toString("utf8");
  const decode = (value: string) =>
    value.replace(
      /&(?:lt|gt|amp|quot|apos);/g,
      (entity) => ({ "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" })[entity] ?? entity,
    );
  const code = xml.match(/<Code>\s*([^<]*?)\s*<\/Code>/)?.[1];
  const message = xml.match(/<Message>\s*([^<]*?)\s*<\/Message>/)?.[1];
  const detail = [code, message]
    .filter((text): text is string => Boolean(text))
    .map(decode)
    .join(": ");
  return new Error(`HTTP ${status}${detail ? `: ${detail}` : ""}`);
};

const putObject = (url: URL, object: NotebookBackupObject, addresses: PublicNetworkAddress[], deps: SnapshotHttpDeps): Promise<number> =>
  new Promise((resolve, reject) => {
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
        const success = status >= 200 && status < 300;
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = () => (success ? resolve(body.length) : reject(providerError(status, Buffer.concat(chunks, size))));
        response.on("data", (chunk: Buffer | string) => {
          if (success) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = MAX_ERROR_BYTES - size;
          chunks.push(buffer.subarray(0, remaining));
          size += Math.min(remaining, buffer.length);
          if (size === MAX_ERROR_BYTES) {
            finish();
            response.destroy();
            request.destroy();
          }
        });
        response.once("end", finish);
        response.once("error", () => reject(new Error("S3 response connection failed")));
        response.once("aborted", () => reject(new Error("S3 response connection failed")));
      },
    );
    request.setTimeout(60_000, () => request.destroy(new Error("S3 upload timed out without progress")));
    request.once("error", () => reject(new Error("S3 upload connection failed or timed out")));
    request.end(body);
  });

export const uploadSnapshotObjects = async (
  config: SigningConfig,
  objects: NotebookBackupObject[],
  deps: SnapshotHttpDeps = {},
): Promise<NotebookBackupUploadResult[]> => {
  if (!objects.length) return [];
  const presign = deps.presign ?? presignSnapshotObject;
  const target = presign(config, objects[0]!.path);
  const addresses = await resolveAllowedNetworkAddresses(target.hostname, deps.allowlist ?? EMPTY_NETWORK_ALLOWLIST, deps.lookup);
  const uploaded: NotebookBackupUploadResult[] = [];
  for (const object of objects) {
    // Sign right before each request so a long upload never sends an expired signature.
    const url = presign(config, object.path);
    if (url.origin !== target.origin) throw new Error("S3 upload target changed between objects");
    try {
      const bytes = await putObject(url, object, addresses, deps);
      uploaded.push({ path: object.path, bytes });
    } catch (error) {
      throw new Error(`Failed to upload ${object.path}. ${error instanceof Error ? error.message : "S3 upload failed"}`);
    }
  }
  return uploaded;
};
