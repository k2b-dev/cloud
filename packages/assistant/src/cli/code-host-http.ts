import { timingSafeEqual } from "node:crypto";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { LIMITS } from "../artifacts/contracts";

// One network operation per admitted managed host. Reject before consuming bodies.
const MAX_TRANSFERS = 8;
let transfers = 0;
export const HOST_HEADER = "x-cloud-code-host";
export function createCodeHostHttp(ctx: Pick<CloudCliContext, "fetch">) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const lifetime = new AbortController();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: LIMITS.inputFileBytes + LIMITS.rpcBytes,
    idleTimeout: 255,
    async fetch(request) {
      const supplied = request.headers.get(HOST_HEADER) ?? "";
      if (Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token)))
        return new Response(null, { status: 403 });
      const url = new URL(request.url);
      if (url.pathname === "/" && request.method === "GET")
        return new Response("<!doctype html><body></body>", { headers: { "content-type": "text/html", "cache-control": "no-store" } });
      if (!url.pathname.startsWith("/api/assistant/artifacts/") && !url.pathname.startsWith("/api/ai/conversations/"))
        return new Response(null, { status: 403 });
      if (transfers >= MAX_TRANSFERS) return Response.json({ code: "operation_busy" }, { status: 409 });
      transfers++;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          transfers--;
        }
      };
      const signal = AbortSignal.any([request.signal, lifetime.signal, AbortSignal.timeout(300_000)]);
      try {
        const response = await ctx.fetch(url.pathname + url.search, {
          method: request.method,
          signal,
          headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
          ...(request.body ? { body: request.body, duplex: "half" } : {}),
          redirect: "error",
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new Error("Host redirects are forbidden");
        }
        const headers = new Headers(response.headers);
        headers.delete("set-cookie");
        headers.set("cache-control", "no-store");
        if (!response.body) {
          release();
          return new Response(null, { status: response.status, headers });
        }
        const reader = response.body.getReader();
        const cancel = () => {
          void reader
            .cancel(signal.reason)
            .catch(() => {})
            .finally(release);
        };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) {
          cancel();
          signal.throwIfAborted();
        }
        const finish = () => {
          signal.removeEventListener("abort", cancel);
          release();
        };
        return new Response(
          new ReadableStream({
            async pull(controller) {
              try {
                signal.throwIfAborted();
                const chunk = await reader.read();
                signal.throwIfAborted();
                if (chunk.done) {
                  finish();
                  controller.close();
                } else controller.enqueue(chunk.value);
              } catch (error) {
                finish();
                controller.error(error);
              }
            },
            async cancel(reason) {
              try {
                await reader.cancel(reason);
              } finally {
                finish();
              }
            },
          }),
          { status: response.status, headers },
        );
      } catch {
        release();
        return Response.json({ code: "HOST_TRANSFER_FAILED" }, { status: signal.aborted ? 499 : 502 });
      }
    },
  });
  return {
    origin: server.url.origin,
    token,
    close: () => {
      lifetime.abort();
      server.stop(true);
    },
  };
}
