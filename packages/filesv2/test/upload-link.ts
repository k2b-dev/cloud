import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import type { Socket } from "node:net";

const sockets = new Set<Socket>();
// A shared uplink FIFO, not one independent throttle per browser connection.
// No root, network configuration or external services. 2 Mbit/s, 2 s queue.
const rate = 250_000;
const capacity = 500_000;
let queued = 0;
let maximum = 0;
let last = performance.now();
type Packet = { bytes: number; finish: () => void; admitted: () => void };
const packets: Packet[] = [];
const waiting: Packet[] = [];
function admit() {
  while (waiting.length && queued + waiting[0]!.bytes <= capacity) {
    const packet = waiting.shift()!;
    queued += packet.bytes;
    maximum = Math.max(maximum, queued);
    packets.push(packet);
    packet.admitted();
  }
}
async function offer(bytes: number) {
  const done = Promise.withResolvers<void>();
  const admitted = Promise.withResolvers<void>();
  waiting.push({ bytes, finish: done.resolve, admitted: admitted.resolve });
  admit();
  await admitted.promise;
  return { done: done.promise };
}
const partSize = 1024 * 1024;
const receipts = new Map<number, { index: number; hash: string; size: number }>();
const puts: number[] = [];
const status = () => ({
  id: "fixture",
  root: "test",
  size: partSize * 2,
  chunkSize: partSize,
  state: "open",
  expires: "2099-01-01T00:00:00Z",
  received: [...receipts.values()].reduce((sum, part) => sum + part.size, 0),
  uploadedSegments: receipts.size,
});
const script = await readFile(process.argv[4]!, "utf8");
async function handler(req: IncomingMessage | Http2ServerRequest, res: ServerResponse | Http2ServerResponse) {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/metrics") {
      res.end(JSON.stringify({ maximum, puts, receipts: [...receipts.values()] }));
      return;
    }
    if (url.pathname === "/reset") {
      receipts.clear();
      puts.length = 0;
      res.end("ok");
      return;
    }
    if (url.pathname === "/") {
      res.end('<!doctype html><script type="module" src="/harness.js"></script>');
      return;
    }
    if (url.pathname === "/harness.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(script);
      return;
    }
    const done = [(await offer(512)).done];
    let bytes = 0;
    const hash = createHash("sha256");
    for await (const chunk of req) {
      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += data.length;
      hash.update(data);
      for (let offset = 0; offset < data.length; offset += 16384) done.push((await offer(Math.min(16384, data.length - offset))).done);
    }
    await Promise.all(done);
    await new Promise((resolve) => setTimeout(resolve, 50)); // The server is quick even when the browser waits 2 s.
    let result: unknown = { bytes };
    if (url.pathname === "/lease") {
      if (req.method === "PUT") {
        const index = Number(url.searchParams.get("segment"));
        puts.push(index);
        receipts.set(index, { index, hash: `sha256:${hash.digest("hex")}`, size: bytes });
      }
      result = url.searchParams.has("segments") ? { items: [...receipts.values()] } : status();
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  } catch {
    if (!res.destroyed) {
      res.statusCode = 500;
      res.end();
    }
  }
}
const http = createServer(handler);
const https = createSecureServer(
  { key: await readFile(process.argv[3]!), cert: await readFile(process.argv[2]!), allowHTTP1: true },
  handler,
);
for (const server of [http, https]) {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}
const plain = http.address(),
  secure = https.address();
if (!plain || typeof plain === "string" || !secure || typeof secure === "string") throw new Error("Expected local ports");
console.log(JSON.stringify({ http: `http://127.0.0.1:${plain.port}`, https: `https://127.0.0.1:${secure.port}` }));
last = performance.now();
const interval = setInterval(() => {
  const now = performance.now();
  let budget = ((now - last) * rate) / 1000;
  last = now;
  while (budget > 0 && packets.length) {
    const packet = packets[0]!;
    const amount = Math.min(budget, packet.bytes);
    packet.bytes -= amount;
    queued -= amount;
    budget -= amount;
    if (packet.bytes < 0.001) {
      packets.shift();
      packet.finish();
    }
    admit();
  }
}, 5);

process.on("SIGTERM", () => {
  clearInterval(interval);
  for (const socket of sockets) socket.destroy();
  http.close();
  https.close();
});
