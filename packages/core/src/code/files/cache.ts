import { createHash, randomUUID } from "node:crypto";
import { redis } from "@k2b/cloud";
import { CODE_FILE_LIMITS } from "@k2b/cloud/code";
import type { CapabilityExecutionContext, CapabilityStream } from "@k2b/cloud/contracts";
import { decryptSecret, encryptSecret } from "@k2b/cloud/services";
import { z } from "zod";

const snapshot = z.strictObject({
  purpose: z.literal("code-generated-file-v1"),
  key: z.uuid(),
  binding: z.string(),
  expiresAt: z.number(),
});
export const fileIdentity = (context: CapabilityExecutionContext) =>
  JSON.stringify([
    context.accessSubject.type === "user"
      ? ["user", context.accessSubject.userId]
      : ["service_account", context.accessSubject.serviceAccountId],
    context.actor.delegation?.mandateId ?? null,
    context.actor.delegation?.workloadId ?? null,
    context.actor.delegation?.workloadRun ?? null,
  ]);
const cacheKey = (key: string) => `code:generated-file:v1:${key}`;
const budgetKey = (context: CapabilityExecutionContext) =>
  `code:generated-budget:v1:${createHash("sha256").update(fileIdentity(context)).digest("hex")}`;
// Reserve output memory before rendering, including concurrent calls. Failed work
// keeps its reservation; a success refunds the unused allowance, never its count.
export const RESERVE_FILE = `
local count = tonumber(redis.call('HGET', KEYS[1], 'count') or '0')
local bytes = tonumber(redis.call('HGET', KEYS[1], 'bytes') or '0')
if count >= tonumber(ARGV[1]) or bytes + tonumber(ARGV[2]) > tonumber(ARGV[3]) then return 0 end
redis.call('HINCRBY', KEYS[1], 'count', 1)
redis.call('HINCRBY', KEYS[1], 'bytes', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1`;
export const REFUND_FILE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
return redis.call('HINCRBY', KEYS[1], 'bytes', ARGV[1])`;
type GeneratedFileCacheDependencies = {
  send: (command: string, args: string[]) => Promise<unknown>;
  seal: (value: unknown) => Promise<string>;
  unseal: (value: string) => Promise<unknown>;
};
const cacheDependencies: GeneratedFileCacheDependencies = {
  send: (command, args) => redis.send(command, args),
  seal: encryptSecret,
  unseal: decryptSecret,
};
export function createGeneratedFileCache(dependencies: GeneratedFileCacheDependencies = cacheDependencies) {
  async function reserveGeneratedFile(context: CapabilityExecutionContext) {
    context.signal.throwIfAborted();
    const key = budgetKey(context);
    const granted = await dependencies.send("EVAL", [
      RESERVE_FILE,
      "1",
      key,
      String(CODE_FILE_LIMITS.files),
      String(CODE_FILE_LIMITS.fileBytes),
      String(CODE_FILE_LIMITS.totalBytes),
      String(CODE_FILE_LIMITS.ttlSeconds),
    ]);
    if (granted !== 1)
      throw Object.assign(new Error("File generation exceeds this run's file count or byte budget."), {
        code: "CODE_FILE_LIMIT",
        status: 429,
      });
    return key;
  }
  async function cacheGeneratedFile(
    bytes: Uint8Array,
    name: string,
    mediaType: string,
    context: CapabilityExecutionContext,
    reservation: string,
  ): Promise<CapabilityStream> {
    context.signal.throwIfAborted();
    if (bytes.byteLength > CODE_FILE_LIMITS.fileBytes)
      throw Object.assign(new Error("Generated file exceeds 50 MiB."), { code: "CODE_FILE_LIMIT", status: 400 });
    const key = randomUUID();
    const expiresAt = Date.now() + CODE_FILE_LIMITS.ttlSeconds * 1000;
    const binding = fileIdentity(context);
    const id = await dependencies.seal({ purpose: "code-generated-file-v1", key, binding, expiresAt });
    // Cache content is encrypted at rest and expires without a cleanup worker.
    const content = await dependencies.seal({ bytes: Buffer.from(bytes).toString("base64"), name, mediaType, size: bytes.byteLength });
    context.signal.throwIfAborted();
    await dependencies.send("SET", [cacheKey(key), content, "EX", String(CODE_FILE_LIMITS.ttlSeconds)]);
    await dependencies.send("EVAL", [REFUND_FILE, "1", reservation, String(bytes.byteLength - CODE_FILE_LIMITS.fileBytes)]);
    return { id, name, mediaType, size: bytes.byteLength, direction: "read", expiresAt: new Date(expiresAt).toISOString() };
  }
  async function readGeneratedFile(stream: CapabilityStream, context: CapabilityExecutionContext): Promise<Response> {
    const grant = snapshot.parse(await dependencies.unseal(stream.id));
    if (grant.binding !== fileIdentity(context) || grant.expiresAt <= Date.now()) return new Response(null, { status: 403 });
    const encoded = await dependencies.send("GETDEL", [cacheKey(grant.key)]);
    if (typeof encoded !== "string") return new Response(null, { status: 410 });
    const file = z
      .strictObject({ bytes: z.string(), name: z.string(), mediaType: z.string(), size: z.number() })
      .parse(await dependencies.unseal(encoded));
    const bytes = Buffer.from(file.bytes, "base64");
    if (file.size !== bytes.byteLength || stream.size !== file.size || stream.mediaType !== file.mediaType || stream.name !== file.name)
      return new Response(null, { status: 409 });
    context.signal.throwIfAborted();
    return new Response(bytes, {
      headers: {
        "content-type": file.mediaType,
        "content-length": String(bytes.byteLength),
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
      },
    });
  }
  return { reserve: reserveGeneratedFile, put: cacheGeneratedFile, read: readGeneratedFile };
}
const generatedFiles = createGeneratedFileCache();
export const reserveGeneratedFile = generatedFiles.reserve;
export const cacheGeneratedFile = generatedFiles.put;
export const readGeneratedFile = generatedFiles.read;
