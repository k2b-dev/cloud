import { NetworkTargetBlockedError } from "@k2b/cloud/services";

export const NOTE_PDF_IMAGE_USER_AGENT = "Cloud-Notebooks-PDF/1.0";
export type NotePdfImageFetch = (input: string, init: RequestInit) => Promise<Response>;

type ExternalImageResult =
  | { ok: true; data: Uint8Array }
  | { ok: false; code: "blocked" | "unreachable" | "unsupported_format" | "too_large" | "timed_out" };

/** Fetch one bounded image; every redirect gets fresh validation and anonymous headers. */
export async function fetchNotePdfExternalImage(
  href: string,
  options: { fetch: NotePdfImageFetch; maxBytes: number; signal: AbortSignal },
): Promise<ExternalImageResult> {
  const { fetch, maxBytes, signal } = options;
  let current: URL;
  try {
    current = new URL(href);
  } catch {
    return { ok: false, code: "blocked" };
  }
  for (let redirects = 0; ; redirects++) {
    if (!["http:", "https:"].includes(current.protocol) || current.username || current.password) return { ok: false, code: "blocked" };
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    const abort = () => {
      void reader?.cancel().catch(() => {});
    };
    try {
      signal.throwIfAborted();
      response = await fetch(current.href, {
        headers: { accept: "image/*", "user-agent": NOTE_PDF_IMAGE_USER_AGENT },
        redirect: "manual",
        signal,
      });
      signal.throwIfAborted();
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null || redirects >= 20) return { ok: false, code: "unreachable" };
        try {
          current = new URL(location, current);
        } catch {
          return { ok: false, code: "unreachable" };
        }
        continue;
      }
      if (!response.ok) return { ok: false, code: "unreachable" };
      const type = response.headers.get("content-type")?.split(";")[0]!.trim().toLowerCase();
      if (!type?.startsWith("image/") || type === "image/svg+xml") return { ok: false, code: "unsupported_format" };
      if (Number(response.headers.get("content-length")) > maxBytes) return { ok: false, code: "too_large" };
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      if (reader) {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          if (total + chunk.value.byteLength > maxBytes) return { ok: false, code: "too_large" };
          total += chunk.value.byteLength;
          chunks.push(chunk.value);
        }
      }
      const data = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      complete = true;
      return { ok: true, data };
    } catch (error) {
      return { ok: false, code: error instanceof NetworkTargetBlockedError ? "blocked" : signal.aborted ? "timed_out" : "unreachable" };
    } finally {
      signal.removeEventListener("abort", abort);
      if (!complete) {
        if (reader) await reader.cancel().catch(() => {});
        else await response?.body?.cancel().catch(() => {});
      }
      reader?.releaseLock();
    }
  }
}
