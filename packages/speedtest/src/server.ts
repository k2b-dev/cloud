import { isIP } from "node:net";
import { canonicalAddress } from "./address";
import { type CapacityOptions, TestAdmission } from "./admission";
import { CHUNK_BYTES, DOWNLOAD_BYTES, UPLOAD_BYTES } from "./engine";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Speedtest-Token",
  "Access-Control-Expose-Headers": "Retry-After",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, no-transform",
  "X-Content-Type-Options": "nosniff",
};
export interface ServerOptions extends CapacityOptions {
  trustedProxies?: readonly string[];
  script?: string;
  now?: () => number;
}
export function createSpeedtestHandler(options: ServerOptions) {
  const budget = new TestAdmission(options);
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
    if (!["/session", "/session/end", "/ping", "/download", "/upload"].includes(url.pathname)) return respond("Not found", 404);

    const forwarded = request.headers.get("x-real-ip");
    const ip = isIP(remoteIp) && trusted.has(canonicalAddress(remoteIp)) && forwarded && isIP(forwarded) ? forwarded : remoteIp;
    if (!isIP(ip)) return respond("Client address unavailable", 503);
    const token = request.headers.get("x-speedtest-token");
    if (url.pathname === "/session" && request.method === "POST") {
      await request.body?.cancel();
      const mode = url.searchParams.get("mode") ?? "quick";
      if (mode !== "quick" && mode !== "accurate") return respond("Invalid mode", 400);
      const result = budget.start(ip, mode);
      return "status" in result
        ? respond(result.status === 429 ? "Test limit exceeded" : "Server busy", result.status, {
            "Retry-After": String(result.retryAfter),
          })
        : respond(JSON.stringify(result), 201, { "Content-Type": "application/json" });
    }
    if (url.pathname === "/session" && request.method === "GET") {
      const status = budget.status(ip, token);
      return status ? respond(JSON.stringify(status), 200, { "Content-Type": "application/json" }) : respond("Test session expired", 401);
    }
    if (url.pathname === "/session/end" && request.method === "POST") {
      await request.body?.cancel();
      budget.end(ip, token);
      return respond(null, 204);
    }
    if (url.pathname.startsWith("/session")) return respond("Method not allowed", 405);
    if (request.method !== (url.pathname === "/upload" ? "POST" : "GET")) return respond("Method not allowed", 405);
    if (url.pathname === "/ping" && !token) return respond(null, 204);
    const lease = budget.acquire(ip, token);
    if ("status" in lease) {
      await request.body?.cancel();
      return respond(lease.status === 401 ? "Test session required" : "Server budget exceeded", lease.status, {
        "Retry-After": String(lease.retryAfter),
      });
    }
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
        lease.signal.removeEventListener("abort", cancel);
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
            stopTimeout = setTimeout(cancel, Math.min(14_000, lease.remaining));
            request.signal.addEventListener("abort", cancel, { once: true });
            lease.signal.addEventListener("abort", cancel, { once: true });
            if (request.signal.aborted || lease.signal.aborted) cancel();
          },
          pull(value) {
            if (closed) return;
            const part = chunk.subarray(0, Math.min(CHUNK_BYTES, size - sent));
            if (!lease.consume(part.byteLength)) {
              cancel();
              return;
            }
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
    const timeout = setTimeout(cancel, Math.min(14_000, lease.remaining));
    request.signal.addEventListener("abort", cancel, { once: true });
    lease.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted || lease.signal.aborted) cancel();
    let bytes = 0;
    try {
      while (!expired) {
        const value = await reader.read();
        if (value.done) break;
        if (!lease.consume(value.value.byteLength)) {
          await reader.cancel();
          return respond("Server bandwidth budget exceeded", 503, { "Retry-After": "1" });
        }
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
      lease.signal.removeEventListener("abort", cancel);
      reader.releaseLock();
      lease.release();
    }
  };
}
