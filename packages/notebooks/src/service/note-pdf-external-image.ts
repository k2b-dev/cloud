import { NetworkTargetBlockedError, type requestPublicHttps } from "@k2b/cloud/services";

export const NOTE_PDF_IMAGE_USER_AGENT = "Cloud-Notebooks-PDF/1.0";
export type NotePdfImageRequest = typeof requestPublicHttps;

type ExternalImageResult =
  | { ok: true; data: Uint8Array }
  | { ok: false; code: "blocked" | "unreachable" | "unsupported_format" | "too_large" | "timed_out" };

/** One anonymous, bounded public HTTPS request. Redirects never receive another request. */
export async function fetchNotePdfExternalImage(
  href: string,
  options: { request: NotePdfImageRequest; maxBytes: number; signal: AbortSignal },
): Promise<ExternalImageResult> {
  const { request, maxBytes, signal } = options;
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.username || url.password) return { ok: false, code: "blocked" };
    signal.throwIfAborted();
    const response = await request({
      url: url.href,
      method: "GET",
      headers: { accept: "image/*", "user-agent": NOTE_PDF_IMAGE_USER_AGENT },
      maxBytes,
      signal,
    });
    signal.throwIfAborted();
    if (response.status < 200 || response.status >= 300) return { ok: false, code: "unreachable" };
    const type = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (!type?.startsWith("image/") || type === "image/svg+xml") return { ok: false, code: "unsupported_format" };
    return { ok: true, data: response.body };
  } catch (error) {
    const code = signal.aborted
      ? "timed_out"
      : error instanceof NetworkTargetBlockedError
        ? "blocked"
        : error instanceof Error && error.message === "HTTP_TOO_LARGE"
          ? "too_large"
          : "unreachable";
    return { ok: false, code };
  }
}
