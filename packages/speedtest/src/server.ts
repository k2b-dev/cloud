import { isIP } from "node:net";
import { canonicalAddress } from "./address";
import { IpBudget } from "./budget";
import { CHUNK_BYTES, DOWNLOAD_BYTES, UPLOAD_BYTES } from "./engine";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "Retry-After",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, no-transform",
  "X-Content-Type-Options": "nosniff",
};
export interface ServerOptions {
  maxPeers: number;
  maxActive: number;
  trustedProxies?: readonly string[];
  script?: string;
  now?: () => number;
}
export function createSpeedtestHandler(options: ServerOptions) {
  const budget = new IpBudget(options);
  const chunk = new Uint8Array(CHUNK_BYTES);
  crypto.getRandomValues(chunk);
  const trusted = new Set((options.trustedProxies ?? []).map(canonicalAddress));
  return async (request: Request, remoteIp: string): Promise<Response> => {
    const url = new URL(request.url);
    const respond = (body: BodyInit | null, status = 200, extra?: HeadersInit) => {
      const all = new Headers(headers);
      if (extra) new Headers(extra).forEach((value, key) => all.set(key, value));
      return new Response(body, { status, headers: all });
    };
    if (request.method === "OPTIONS") return respond(null, 204);
    if (url.pathname === "/health" && request.method === "GET") return respond("ok");
    // Served script contains exactly the same engine and transport, bundled during image build.
    if (url.pathname === "/cli" && request.method === "GET")
      return options.script
        ? respond(options.script, 200, { "Content-Type": "text/javascript; charset=utf-8" })
        : respond("CLI bundle is unavailable", 503);
    if (!["/ping", "/download", "/upload"].includes(url.pathname)) return respond("Not found", 404);
    if (request.method !== (url.pathname === "/upload" ? "POST" : "GET")) return respond("Method not allowed", 405);
    const forwarded = request.headers.get("x-real-ip");
    const ip = isIP(remoteIp) && trusted.has(canonicalAddress(remoteIp)) && forwarded && isIP(forwarded) ? forwarded : remoteIp;
    if (!isIP(ip)) return respond("Client address unavailable", 503);
    const lease = budget.acquire(ip, url.pathname !== "/ping");
    if ("status" in lease)
      return respond(lease.status === 429 ? "IP budget exceeded" : "Server busy", lease.status, {
        "Retry-After": String(lease.retryAfter),
      });
    if (url.pathname === "/ping") {
      lease.release();
      return respond(null, 204);
    }
    if (url.pathname === "/download") {
      const raw = url.searchParams.get("size");
      const size = raw === null ? DOWNLOAD_BYTES : Number(raw);
      if (!Number.isSafeInteger(size) || size <= 0 || size > DOWNLOAD_BYTES) {
        lease.release();
        return respond("Invalid download size", 400);
      }
      let sent = 0;
      let closed = false;
      let stopTimeout: ReturnType<typeof setTimeout>;
      const finish = () => {
        if (closed) return;
        closed = true;
        clearTimeout(stopTimeout);
        request.signal.removeEventListener("abort", cancel);
        lease.release();
      };
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const cancel = () => {
        if (!closed) {
          finish();
          controller.error(new Error("Transfer stopped"));
        }
      };
      const stream = new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value;
            stopTimeout = setTimeout(cancel, 14_000);
            request.signal.addEventListener("abort", cancel, { once: true });
            if (request.signal.aborted) cancel();
          },
          pull(value) {
            if (closed) return;
            const part = chunk.subarray(0, Math.min(CHUNK_BYTES, size - sent));
            value.enqueue(part);
            sent += part.byteLength;
            if (sent === size) {
              finish();
              value.close();
            }
          },
          cancel: finish,
        },
        { highWaterMark: 0 },
      );
      return respond(stream, 200, { "Content-Type": "application/octet-stream", "Content-Length": String(size) });
    }
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > UPLOAD_BYTES)) {
      lease.release();
      await request.body?.cancel();
      return respond("Upload too large", 413);
    }
    const reader = request.body?.getReader();
    if (!reader) {
      lease.release();
      return respond('{"bytes":0}', 200, { "Content-Type": "application/json" });
    }
    let expired = false;
    const cancel = () => {
      expired = true;
      void reader.cancel().catch(() => {});
    };
    const timeout = setTimeout(cancel, 14_000);
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();
    let bytes = 0;
    try {
      while (!expired) {
        const value = await reader.read();
        if (value.done) break;
        bytes += value.value.byteLength;
        if (bytes > UPLOAD_BYTES) {
          await reader.cancel();
          return respond("Upload too large", 413);
        }
      }
      if (expired) return respond("Transfer stopped", 408);
      return respond(JSON.stringify({ bytes }), 200, { "Content-Type": "application/json" });
    } catch {
      return respond("Upload interrupted", 400);
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", cancel);
      reader.releaseLock();
      lease.release();
    }
  };
}
