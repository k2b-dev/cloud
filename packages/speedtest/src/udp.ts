import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { IpBudget } from "./budget";

export const UDP_PACKET_BYTES = 64;
export const UDP_HELLO = 1;
export const UDP_CHALLENGE = 2;
export const UDP_PROBE = 3;
export const UDP_REPLY = 4;

/** Stateless address-and-port proof. Even challenges never exceed the request size. */
export function createUdpHandler(options: { maxPeers: number; secret?: Uint8Array; now?: () => number; maxPacketsPerSecond?: number }) {
  const key = options.secret ?? randomBytes(32);
  const now = options.now ?? Date.now;
  const budget = new IpBudget({ maxPeers: options.maxPeers, maxActive: 1, now });
  const sign = (packet: Uint8Array, address: string, port: number) =>
    createHmac("sha256", key).update(`${address}:${port}:`).update(packet.subarray(1, 25)).digest();
  let windowStart = now();
  let packetCount = 0;
  return (packet: Uint8Array, address: string, port: number): Uint8Array | null => {
    if (packet.byteLength !== UDP_PACKET_BYTES) return null;
    const time = now();
    if (time - windowStart >= 1_000) {
      windowStart = time;
      packetCount = 0;
    }
    if (++packetCount > (options.maxPacketsPerSecond ?? 4_096)) return null;
    if (packet[0] === UDP_HELLO) {
      const reply = new Uint8Array(UDP_PACKET_BYTES);
      reply[0] = UDP_CHALLENGE;
      new DataView(reply.buffer).setFloat64(1, now() + 30_000);
      reply.set(randomBytes(16), 9);
      reply.set(sign(reply, address, port), 25);
      return reply;
    }
    if (packet[0] !== UDP_PROBE) return null;
    const expiry = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getFloat64(1);
    if (!Number.isFinite(expiry) || expiry < now() || expiry > now() + 30_000) return null;
    if (!timingSafeEqual(packet.subarray(25, 57), sign(packet, address, port))) return null;
    // Only a confirmed address may allocate an IP ledger entry.
    const lease = budget.acquire(address, true);
    if ("status" in lease) return null;
    lease.release();
    const reply = packet.slice();
    reply[0] = UDP_REPLY;
    return reply;
  };
}
