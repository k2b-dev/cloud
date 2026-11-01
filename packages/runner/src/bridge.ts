import type { AppKey } from "@k2b/cloud/app-key";
import { signAppProof } from "@k2b/cloud/app-proof";
import {
  RUNNER_PATHS,
  type RunnerBridge,
  RunnerCallResponseSchema,
  type RunnerConfig,
  RunnerConfigSchema,
  RunnerFetchResponseSchema,
  RunnerHeartbeatResponseSchema,
  RunnerLeaseLostError,
} from "@k2b/cloud/code/runner";

/** Read bounded bytes, including chunked responses. A timeout also bounds body consumption. */
export const readBytes = async (response: Response, max: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> => {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        abort();
        throw new Error("runner_response_too_large");
      }
      chunks.push(value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
};

/** Signed HTTP seam; no app runtime import, bootstrap, infrastructure client or redirect. */
export class CoreBridge implements RunnerBridge {
  #config: RunnerConfig | undefined;
  readonly origin: URL;
  constructor(
    readonly key: AppKey,
    origin: string,
    readonly send: typeof fetch = fetch,
  ) {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("CLOUD_CORE_INTERNAL_ORIGIN must be a direct http(s) Core origin");
    if (key.appId !== "runner") throw new Error("Expected the runner app key");
    this.origin = url;
  }
  async #post(path: string, payload: unknown, signal: AbortSignal, max = 64 * 1024, timeoutMs = 10_000) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const bounded = AbortSignal.any([signal, timeout]);
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const proof = await signAppProof(this.key, { method: "POST", path, body });
    bounded.throwIfAborted();
    const response = await this.send(new URL(path, this.origin), {
      method: "POST",
      headers: { Authorization: `Bearer ${proof}`, "Content-Type": "application/json" },
      body,
      timeout: false,
      redirect: "error",
      signal: bounded,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 409) throw new RunnerLeaseLostError();
      throw new Error(`runner_core_http_${response.status}`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(response, max, bounded));
  }
  async configure(signal: AbortSignal) {
    this.#config = RunnerConfigSchema.parse(JSON.parse(await this.#post(RUNNER_PATHS.config, {}, signal)));
    return this.#config;
  }
  #settings() {
    if (!this.#config) throw new Error("Runner must configure before polling");
    return this.#config;
  }
  async fetch(request: Parameters<RunnerBridge["fetch"]>[0], signal: AbortSignal) {
    const config = this.#settings();
    return RunnerFetchResponseSchema.parse(
      JSON.parse(await this.#post(RUNNER_PATHS.fetch, request, signal, 64 * 1024 * request.freeSlots, config.pollMs + config.transportMs)),
    );
  }
  async jobHeartbeat(request: import("@k2b/cloud/code/runner").RunnerJobProof, signal: AbortSignal) {
    return RunnerHeartbeatResponseSchema.parse(
      JSON.parse(await this.#post(RUNNER_PATHS.heartbeat, request, signal, 64 * 1024, this.#settings().transportMs)),
    );
  }
  async jobComplete(request: import("zod").z.infer<typeof import("@k2b/cloud/code/runner").RunnerJobCompleteSchema>, signal: AbortSignal) {
    await this.#post(RUNNER_PATHS.complete, request, signal, 64 * 1024, this.#settings().transportMs);
  }
  async jobInput(request: import("@k2b/cloud/code/runner").RunnerJobProof, signal: AbortSignal, maxBytes: number) {
    return this.#post(RUNNER_PATHS.jobInput, request, signal, maxBytes, this.#settings().transportMs);
  }
  async bundle(request: Parameters<RunnerBridge["bundle"]>[0], signal: AbortSignal) {
    const config = this.#settings();
    return this.#post(RUNNER_PATHS.bundle, request, signal, config.bundleBytes, config.transportMs);
  }
  async heartbeat(request: Parameters<RunnerBridge["heartbeat"]>[0], signal: AbortSignal) {
    return RunnerHeartbeatResponseSchema.parse(
      JSON.parse(await this.#post(RUNNER_PATHS.heartbeat, request, signal, 64 * 1024, this.#settings().transportMs)),
    );
  }
  async complete(request: Parameters<RunnerBridge["complete"]>[0], signal: AbortSignal) {
    await this.#post(RUNNER_PATHS.complete, request, signal, 64 * 1024, this.#settings().transportMs);
  }
  async call(request: Parameters<RunnerBridge["call"]>[0], signal: AbortSignal) {
    const config = this.#settings();
    if (Buffer.byteLength(JSON.stringify(request)) > config.bridgeBytes) throw new Error("runner_call_too_large");
    return RunnerCallResponseSchema.parse(
      JSON.parse(await this.#post(RUNNER_PATHS.call, request, signal, config.bridgeBytes, config.transportMs)),
    );
  }
}
