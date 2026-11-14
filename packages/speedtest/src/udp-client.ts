import { createSocket, type Socket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { jitter, median, normalizeServer, SpeedtestError } from "./engine";
import { UDP_CHALLENGE, UDP_HELLO, UDP_PACKET_BYTES, UDP_PROBE, UDP_REPLY } from "./udp";

/** Explicit CLI diagnostic. Late replies are matched by sequence until the total deadline. */
export async function runUdpTest(server: string, options: { port?: number; signal?: AbortSignal } = {}) {
  const url = new URL(normalizeServer(server));
  const port = options.port ?? (url.port ? Number(url.port) : 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid UDP port");
  const root = new AbortController();
  let expired = false;
  const cancel = () => root.abort(new SpeedtestError("cancelled", "UDP test cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const deadline = setTimeout(() => {
    expired = true;
    root.abort();
  }, 2_000);
  let socket: Socket | undefined;
  try {
    root.signal.throwIfAborted();
    let rejectLookup: (error: unknown) => void = () => {};
    const cancelledLookup = () => rejectLookup(root.signal.reason);
    root.signal.addEventListener("abort", cancelledLookup, { once: true });
    let resolved: Awaited<ReturnType<typeof lookup>>;
    try {
      resolved = await Promise.race([
        lookup(url.hostname.replace(/^\[|\]$/g, "")),
        new Promise<never>((_, reject) => {
          rejectLookup = reject;
        }),
      ]);
    } finally {
      root.signal.removeEventListener("abort", cancelledLookup);
    }
    root.signal.throwIfAborted();
    const { address, family } = resolved;
    const connection = createSocket(family === 6 ? "udp6" : "udp4");
    socket = connection;
    return await new Promise<{
      server: string;
      udp_port: number;
      sent: number;
      received: number;
      packet_loss_percent: number;
      ping_ms: number | null;
      jitter_ms: number | null;
    }>((resolve, reject) => {
      let challenge: Uint8Array | undefined;
      let sender: ReturnType<typeof setTimeout> | undefined;
      const sent = new Map<number, number>();
      const replies = new Map<number, number>();
      let finished = false;
      const cleanup = () => {
        finished = true;
        clearTimeout(sender);
        root.signal.removeEventListener("abort", aborted);
        connection.removeListener("message", receive);
      };
      const fail = (error: unknown) => {
        if (!finished) {
          cleanup();
          reject(error);
        }
      };
      const done = () => {
        if (finished) return;
        const samples = [...replies].sort(([a], [b]) => a - b).map(([, value]) => value);
        cleanup();
        resolve({
          server: url.origin,
          udp_port: port,
          sent: sent.size,
          received: replies.size,
          packet_loss_percent: ((sent.size - replies.size) / sent.size) * 100,
          ping_ms: samples.length ? median(samples) : null,
          jitter_ms: samples.length >= 2 ? jitter(samples) : null,
        });
      };
      const aborted = () => {
        if (expired && challenge && sent.size) done();
        else fail(expired ? new SpeedtestError("network", "UDP server did not complete the handshake") : root.signal.reason);
      };
      const sendProbe = () => {
        if (finished || !challenge) return;
        const sequence = sent.size;
        const packet = challenge.slice();
        packet[0] = UDP_PROBE;
        packet[63] = sequence;
        sent.set(sequence, performance.now());
        connection.send(packet, port, address, (error) => {
          if (error) fail(error);
        });
        if (sent.size < 20) sender = setTimeout(sendProbe, 25);
      };
      const receive = (reply: Buffer, remote: { address: string; port: number }) => {
        if (finished || remote.address !== address || remote.port !== port || reply.byteLength !== UDP_PACKET_BYTES) return;
        if (!challenge && reply[0] === UDP_CHALLENGE) {
          challenge = reply.slice();
          sendProbe();
          return;
        }
        if (!challenge || reply[0] !== UDP_REPLY || !reply.subarray(1, 57).every((value, index) => value === challenge![index + 1])) return;
        const sequence = reply[63]!;
        const before = sent.get(sequence);
        if (before === undefined || replies.has(sequence)) return;
        replies.set(sequence, performance.now() - before);
        if (sent.size === 20 && replies.size === sent.size) done();
      };
      connection.on("error", fail);
      connection.on("message", receive);
      root.signal.addEventListener("abort", aborted, { once: true });
      if (root.signal.aborted) {
        aborted();
        return;
      }
      const hello = new Uint8Array(UDP_PACKET_BYTES);
      hello[0] = UDP_HELLO;
      connection.send(hello, port, address, (error) => {
        if (error) fail(error);
      });
    });
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", cancel);
    try {
      socket?.close();
    } catch {
      /* Cancellation can leave the socket unopened. */
    }
  }
}
