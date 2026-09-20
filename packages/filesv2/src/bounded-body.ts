import { FilesError } from "./service/errors";

/** Read bounded bytes even when a server omits or lies about Content-Length. */
export async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<ArrayBuffer> {
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
