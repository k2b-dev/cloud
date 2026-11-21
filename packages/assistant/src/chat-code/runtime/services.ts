import {
  CapabilityFileMetadataSchema,
  CapabilityIdempotencyKeySchema,
  CapabilityInvocationBodySchema,
  capabilityResultSchema,
} from "@k2b/cloud/contracts";
import { z } from "zod";
import { LIMITS } from "../contracts";
import { CloudError } from "./errors";
import { RuntimeStream, runStream } from "./streams";

/** Normalized coordinates and retry metadata; validated again at the authenticated capability endpoint. */
export const RuntimeSdkCallOptions = z
  .object({
    target: CapabilityInvocationBodySchema.shape.target,
    refs: CapabilityInvocationBodySchema.shape.refs,
    idempotencyKey: CapabilityIdempotencyKeySchema.optional(),
  })
  .strict();
export type RuntimeSdkCallOptions = z.infer<typeof RuntimeSdkCallOptions>;

/** Host services behind `cloud.*`, for runner script runs. Each one rechecks access on the server. */
export type RuntimeServices = {
  stream?: typeof runStream;
  /** Loads a lazy runtime chunk from the owning host. */
  chunk?: (name: string, signal: AbortSignal) => Promise<string>;
  capability?: (name: string, input: unknown, signal: AbortSignal, options?: RuntimeSdkCallOptions) => Promise<unknown>;
  http?: (request: unknown, signal: AbortSignal) => Promise<unknown>;
  ai?: (request: unknown, signal: AbortSignal) => Promise<unknown>;
  pdf?: (request: unknown, signal: AbortSignal) => Promise<Blob>;
};

/** Calls that wait for a person to confirm something in Cloud. */
export const APPROVAL_METHODS: ReadonlySet<string> = new Set(["capabilities.run", "http.fetch"]);
const CHUNKS = new Set(["csv", "sheet", "finance", "pdf-read"]);

/** Lazy runtime chunks as JavaScript text from `base` (`/api/assistant/chat-code/runtime` or the public runner). */
export const fetchChunk = (base: string) => async (name: string, signal: AbortSignal) => {
  const response = await fetch(`${base}/chunks/${name}`, { signal });
  if (!response.ok || !/^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i.test(response.headers.get("content-type") ?? ""))
    throw new CloudError(
      "unavailable",
      "The runtime library did not return JavaScript; retry or ask the operator to check the runtime assets.",
    );
  return response.text();
};

/** One dispatcher per run or mount: it owns the capability streams that run was issued. */
export function createServiceCalls(services: RuntimeServices) {
  const chunk = services.chunk;
  const streams = new Map<string, RuntimeStream>();
  const spent = new Set<string>();
  const fileRef = CapabilityFileMetadataSchema.extend({ id: z.string().min(1).max(8192) }).strict();
  let streamBytes = 0;
  const checkStream = (ref: RuntimeStream, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (Date.parse(ref.expiresAt) <= Date.now()) throw new CloudError("denied", "File reference expired.");
    if (ref.size > LIMITS.inputFileBytes) throw new CloudError("limit", "Stream exceeds the 50 MiB code-run file budget.");
  };
  const reserveBytes = (size: number) => {
    if (streamBytes + size > LIMITS.inputBytes) throw new CloudError("limit", "Stream transfers exceed the 250 MiB run budget.");
    streamBytes += size;
  };
  const transfer = (ref: RuntimeStream, verb: string, body: Blob | undefined, signal: AbortSignal) => {
    checkStream(ref, signal);
    return (services.stream ?? runStream)(ref, verb, body, signal);
  };
  return async (method: string, args: unknown[], signal: AbortSignal): Promise<unknown> => {
    switch (method) {
      case "runtime.chunk": {
        const name = args[0];
        if (typeof name !== "string" || !CHUNKS.has(name)) throw new CloudError("invalid", "Unknown runtime library.");
        if (!chunk) throw new CloudError("unavailable", "Runtime library service unavailable");
        return chunk(name, signal);
      }
      case "capabilities.run": {
        if (!services.capability) throw new CloudError("unavailable", "Capability execution unavailable");
        if (typeof args[0] !== "string") throw new CloudError("invalid", "cloud.capabilities.run(name, input) needs a capability name.");
        // The compiler marks SDK streams on the existing RPC; raw calls keep their envelope.
        const direction = args[3] === undefined ? undefined : z.enum(["read", "write"]).parse(args[3]);
        let input = args[1];
        let source: RuntimeStream | undefined;
        if (direction === "write") {
          const object = z.record(z.string(), z.unknown()).parse(input);
          const file = fileRef.parse(object.file);
          source = streams.get(file.id);
          if (
            !source ||
            source.direction !== "read" ||
            source.name !== file.name ||
            source.mediaType !== file.mediaType ||
            source.size !== file.size
          )
            throw new CloudError("denied", "File reference was not issued to this run or its metadata changed.");
          checkStream(source, signal);
          if (spent.has(file.id))
            throw new CloudError("denied", "File reference was already used; inspect the prior write before retrying.");
          reserveBytes(source.size * 2);
          // Reserve before any awaited preparation or transfer, including concurrent calls and uncertain outcomes.
          spent.add(file.id);
          const { id: _id, ...metadata } = file;
          input = { ...object, file: metadata };
        }
        const result = await services.capability(
          args[0],
          input,
          signal,
          args[2] === undefined ? undefined : RuntimeSdkCallOptions.parse(args[2]),
        );
        if (result && typeof result === "object" && "stream" in result && result.stream) {
          const ref = RuntimeStream.parse(result.stream);
          if (streams.size >= LIMITS.files) throw new CloudError("limit", "Too many capability streams in this run.");
          if (direction) {
            checkStream(ref, signal);
            if (ref.direction !== direction) throw new CloudError("invalid", "Wrong SDK stream direction.");
          }
          streams.set(ref.id, ref);
          if (direction === "read") {
            return {
              data: { id: ref.id, ...(ref.name === undefined ? {} : { name: ref.name }), mediaType: ref.mediaType, size: ref.size },
            };
          }
          if (direction === "write" && source) {
            if (ref.size !== source.size || ref.mediaType !== source.mediaType)
              throw new CloudError("invalid", "Write stream differs from the source file.");
            const body = await transfer(source, "read", undefined, signal);
            if (!(body instanceof Blob) || body.size !== source.size) throw new CloudError("invalid", "Incomplete source file.");
            return capabilityResultSchema(z.unknown()).parse(await transfer(ref, "write", body, signal));
          }
        }
        if (direction) throw new CloudError("unavailable", "Capability did not offer the expected file stream.");
        return result;
      }
      case "capabilities.stream": {
        const ref = RuntimeStream.parse(args[0]);
        const known = streams.get(ref.id);
        if (!known || JSON.stringify(known) !== JSON.stringify(ref)) throw new CloudError("denied", "Stream was not issued to this run");
        const verb = args[1];
        if (verb !== "read" && verb !== "write" && verb !== "status" && verb !== "abort")
          throw new CloudError("invalid", "Unknown stream operation.");
        if ((verb === "read") !== (ref.direction === "read")) throw new CloudError("invalid", "Wrong stream direction.");
        if (verb === "read" || verb === "write") {
          reserveBytes(ref.size);
        }
        return transfer(ref, verb, args[2] instanceof Blob ? args[2] : undefined, signal);
      }
      case "http.fetch":
        if (!services.http) throw new CloudError("unavailable", "Server HTTP unavailable");
        return services.http(args[0], signal);
      case "ai":
        if (!services.ai) throw new CloudError("unavailable", "AI requires an authenticated server-backed run");
        return services.ai(args[0], signal);
      case "pdf":
        if (!services.pdf) throw new CloudError("unavailable", "PDF service unavailable");
        return services.pdf(args[0], signal);
      case "database":
        throw new CloudError(
          "unavailable",
          "Studio RSQL database grants are unavailable in runner code_run. Use application capabilities.",
        );
      case "storage":
        throw new CloudError("unavailable", "Studio app storage is unavailable in chat code_run. Use chat or Project files.");
      default:
        throw new CloudError("invalid", "Unsupported host operation");
    }
  };
}
