import type { z } from "zod";
import { LIMITS } from "../contracts";
import { CloudError } from "./errors";
import { RuntimeStorage } from "./shared-storage";
import { RuntimeStream, runStream } from "./streams";

/** Host services behind `cloud.*`, shared by script runs and HTML app frames. Each one rechecks access on the server. */
export type RuntimeServices = {
  /** Loads a lazy runtime chunk; the default reads the authenticated artifacts API. */
  chunk?: (name: string, signal: AbortSignal) => Promise<string>;
  capability?: (name: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  http?: (request: unknown, signal: AbortSignal) => Promise<unknown>;
  ai?: (request: unknown, signal: AbortSignal) => Promise<unknown>;
  pdf?: (request: unknown, signal: AbortSignal) => Promise<Blob>;
  database?: (request: unknown, signal: AbortSignal) => Promise<unknown>;
  storage?: (request: z.infer<typeof RuntimeStorage>) => Promise<unknown>;
};

/** Calls that wait for a person to confirm something in Cloud. */
export const APPROVAL_METHODS: ReadonlySet<string> = new Set(["capabilities.run", "http.fetch"]);
const CHUNKS = new Set(["csv", "sheet", "finance", "pdf-read"]);

/** Lazy runtime chunks as JavaScript text from `base` (`/api/assistant/artifacts/runtime` or the public runner). */
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
  const chunk = services.chunk ?? fetchChunk("/api/assistant/artifacts/runtime");
  const streams = new Map<string, RuntimeStream>();
  let streamBytes = 0;
  return async (method: string, args: unknown[], signal: AbortSignal): Promise<unknown> => {
    switch (method) {
      case "runtime.chunk": {
        const name = args[0];
        if (typeof name !== "string" || !CHUNKS.has(name)) throw new CloudError("invalid", "Unknown runtime library.");
        return chunk(name, signal);
      }
      case "capabilities.run": {
        if (!services.capability) throw new CloudError("unavailable", "Capability execution unavailable");
        if (typeof args[0] !== "string") throw new CloudError("invalid", "cloud.capabilities.run(name, input) needs a capability name.");
        const result = await services.capability(args[0], args[1], signal);
        if (result && typeof result === "object" && "stream" in result && result.stream) {
          const ref = RuntimeStream.parse(result.stream);
          if (streams.size >= LIMITS.files) throw new CloudError("limit", "Too many capability streams in this run.");
          streams.set(ref.id, ref);
        }
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
          if (streamBytes + ref.size > LIMITS.inputBytes) throw new CloudError("limit", "Stream transfers exceed the 250 MiB run budget.");
          streamBytes += ref.size;
        }
        return runStream(ref, verb, args[2] instanceof Blob ? args[2] : undefined, signal);
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
        if (!services.database) throw new CloudError("unavailable", "Database access requires a saved app or script");
        return services.database(args[0], signal);
      case "storage":
        if (!services.storage) throw new CloudError("unavailable", "Storage requires a saved app or script");
        return services.storage(RuntimeStorage.parse(args[0]));
      default:
        throw new CloudError("invalid", "Unsupported host operation");
    }
  };
}
