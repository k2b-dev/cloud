import { Hono } from "hono";
import { type AuthContext } from "@k2b/cloud/server";

// Web Crypto caps getRandomValues at 65536 bytes per call, so the chunk
// has to fit in that window.
const CHUNK_SIZE = 64 * 1024;
const MAX_TRANSFER_BYTES = 200 * 1024 * 1024;

// One incompressible random chunk, generated once at module load and reused
// for every download stream. Re-randomising per request would burn CPU for
// no benefit — the goal is to defeat opportunistic compression in proxies,
// which a single random buffer already does.
const randomChunk = (() => {
  const buf = new Uint8Array(CHUNK_SIZE);
  crypto.getRandomValues(buf);
  return buf;
})();

const noStoreHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};

export default new Hono<AuthContext>()
  .get("/ping", (c) => {
    return new Response(null, { status: 204, headers: noStoreHeaders });
  })
  .get("/download", (c) => {
    const raw = Number.parseInt(c.req.query("size") ?? "", 10);
    const size = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_TRANSFER_BYTES) : 10 * 1024 * 1024;

    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= size) {
          controller.close();
          return;
        }
        const remaining = size - sent;
        const chunk = remaining >= CHUNK_SIZE ? randomChunk : randomChunk.subarray(0, remaining);
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });

    return new Response(stream, {
      headers: {
        ...noStoreHeaders,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
      },
    });
  })
  .post("/upload", async (c) => {
    const body = c.req.raw.body;
    if (!body) return c.json({ ok: true, bytes: 0 });
    const reader = body.getReader();
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) total += value.byteLength;
        if (total > MAX_TRANSFER_BYTES) {
          await reader.cancel();
          return c.json({ error: "upload too large" }, 413);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return c.json({ ok: true, bytes: total });
  });
