import { FilesError } from "./service/errors";

// Per-process payload budgets: at most two conversions (20 MiB source + 8 MiB PNG each),
// plus 64 MiB cached output. Failed/oversized conversions never enter the cache.
export const PREVIEW_LIMITS = {
  inputBytes: 20 * 1024 * 1024,
  outputBytes: 8 * 1024 * 1024,
  cacheBytes: 64 * 1024 * 1024,
  cacheEntries: 128,
  concurrency: 2,
  ttlMs: 5 * 60_000,
  timeoutMs: 30_000,
};

/** Read bounded bytes even when a server omits or lies about Content-Length. */
export async function boundedPreviewBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<ArrayBuffer> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new FilesError("unavailable", 503);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body.cancel();
    throw new FilesError("preview_too_large", 400);
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new FilesError("preview_too_large", 400);
      parts.push(value);
    }
    if (declared !== null && Number(declared) !== size) throw new FilesError("unavailable", 503);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes.buffer;
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type PreviewIdentity = {
  serverUrl: string;
  root: string;
  bindingId: string;
  basePath: string;
  path: string;
  modified: string;
  size: number;
  converterUrl: string;
};
type PreviewRequest = {
  identity: PreviewIdentity;
  source: (signal: AbortSignal) => Promise<Response>;
  convert: (source: ArrayBuffer, signal: AbortSignal) => Promise<Response>;
};

/** Call only after current authorization. Cache identity includes the actual backing store and binding. */
export function createPreviewResources(limits = PREVIEW_LIMITS, now = Date.now) {
  const cache = new Map<string, { bytes: ArrayBuffer; expires: number }>();
  const pending = new Map<string, Promise<ArrayBuffer>>();
  let cachedBytes = 0;
  const remove = (key: string) => {
    const value = cache.get(key);
    if (value) cachedBytes -= value.bytes.byteLength;
    cache.delete(key);
  };
  return async ({ identity, source, convert }: PreviewRequest): Promise<ArrayBuffer> => {
    if (!Number.isSafeInteger(identity.size) || identity.size < 0 || identity.size > limits.inputBytes)
      throw new FilesError("preview_too_large", 400);
    const key = JSON.stringify([
      identity.serverUrl,
      identity.root,
      identity.bindingId,
      identity.basePath,
      identity.path,
      identity.modified,
      identity.size,
      identity.converterUrl,
    ]);
    for (const [storedKey, value] of cache) if (value.expires <= now()) remove(storedKey);
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.bytes;
    }
    const running = pending.get(key);
    if (running) return running;
    if (pending.size >= limits.concurrency) throw new FilesError("unavailable", 503);
    const work = Promise.resolve().then(async () => {
      const signal = AbortSignal.timeout(limits.timeoutMs);
      try {
        const input = await boundedPreviewBody(await source(signal), limits.inputBytes, signal);
        const bytes = await boundedPreviewBody(await convert(input, signal), limits.outputBytes, signal);
        if (bytes.byteLength <= limits.cacheBytes) {
          while (cache.size && (cachedBytes + bytes.byteLength > limits.cacheBytes || cache.size >= limits.cacheEntries))
            remove(cache.keys().next().value!);
          cache.set(key, { bytes, expires: now() + limits.ttlMs });
          cachedBytes += bytes.byteLength;
        }
        return bytes;
      } finally {
        pending.delete(key);
      }
    });
    pending.set(key, work);
    return work;
  };
}
