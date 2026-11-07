import { objectStoreBackend } from "../_internal/object-store-config";
import { validateObjectKey } from "../_internal/object-store-key";
import { get } from "../services/settings";
import { clientIpBucket } from "./client-ip";
import { ratelimit } from "./ratelimit";

const notFound = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

/** Platform-owned anonymous delivery. Never accepts a bucket, private prefix or listing. */
export const servePublicStorage = async (request: Request, clientAddress = "unknown"): Promise<Response> => {
  let path: string;
  try {
    // Validate before application decoding; Bun has already resolved transport
    // dot segments. The S3 key below always starts in the public area.
    const raw = request.url.replace(/^[a-z]+:\/\/[^/]+/i, "").split(/[?#]/, 1)[0] ?? "";
    if (/[\\]|%(?:2e|2f|5c)/i.test(raw)) return notFound();
    const match = /^\/public\/storage\/([a-z][a-z0-9-]{0,79})\/(.+)$/.exec(raw);
    if (!match || match[1] === "storage") return notFound();
    const area = `public/${match[1]}/`;
    path = area + validateObjectKey(decodeURIComponent(match[2] ?? ""), area);
  } catch {
    return notFound();
  }
  if (request.method !== "GET" && request.method !== "HEAD") return notFound();
  try {
    const perSecond = Math.max(1, Math.floor(await get<number>("security.rate_limit_per_second")));
    const budget = await ratelimit({ id: "public-storage", limit: perSecond }).check(clientIpBucket(clientAddress));
    if (budget.limited)
      return new Response("Rate limit exceeded.", {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": String(Math.max(1, Math.ceil(budget.resetIn / 1000))) },
      });
    const { client, limit } = await objectStoreBackend();
    const stat = await client.stat(path);
    if (stat.size > limit) return notFound();
    const headers = new Headers({
      "Content-Type": stat.type || "application/octet-stream",
      "Content-Length": String(stat.size),
      ETag: stat.etag,
      "Last-Modified": stat.lastModified.toUTCString(),
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      // Apply to every type, including mislabelled or future active formats.
      "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
    });
    const essence = stat.type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const inline =
      /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon)|audio\/(?:mpeg|ogg|wav|webm|mp4)|video\/(?:mp4|webm|ogg)|text\/plain)$/;
    if (!inline.test(essence)) headers.set("Content-Disposition", "attachment");
    const ifNoneMatch = request.headers.get("if-none-match");
    const modifiedSince = request.headers.get("if-modified-since");
    if (
      ifNoneMatch
        ? ifNoneMatch.split(",").some((value) => value.trim() === stat.etag || value.trim() === "*")
        : modifiedSince && stat.lastModified.getTime() <= Date.parse(modifiedSince)
    ) {
      headers.delete("Content-Length");
      return new Response(null, { status: 304, headers });
    }
    if (request.method === "HEAD") return new Response(null, { headers });
    const reader = client.file(path).stream().getReader();
    let size = 0;
    const abort = () => {
      void reader.cancel(request.signal.reason).catch(() => {});
    };
    request.signal.addEventListener("abort", abort, { once: true });
    const release = () => {
      request.signal.removeEventListener("abort", abort);
      reader.releaseLock();
    };
    if (request.signal.aborted) abort();
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              release();
              controller.close();
              return;
            }
            size += next.value.byteLength;
            if (size > limit) throw new RangeError("Public object exceeds the configured size limit.");
            controller.enqueue(next.value);
          } catch (error) {
            await reader.cancel(error).catch(() => {});
            release();
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            release();
          }
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, { headers });
  } catch (error) {
    if (error instanceof Error && "code" in error && ["NoSuchKey", "NotFound", "ENOENT"].includes(String(error.code))) return notFound();
    return new Response("Storage is unavailable.", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
};
