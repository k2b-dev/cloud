import { isIP } from "node:net";

const integer = (name: string, fallback: number, max: number) => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 to ${max}`);
  return value;
};
/** Standalone operator configuration. No Cloud runtime or secret service is required. */
export function readServerEnv() {
  const trustedProxies = (process.env.SPEEDTEST_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (trustedProxies.some((value) => !isIP(value))) throw new Error("SPEEDTEST_TRUSTED_PROXIES accepts exact IP addresses only");
  return {
    hostname: process.env.SPEEDTEST_HOST ?? "0.0.0.0",
    port: integer("SPEEDTEST_PORT", 8080, 65_535),
    udpPort: process.env.SPEEDTEST_UDP_PORT ? integer("SPEEDTEST_UDP_PORT", 8080, 65_535) : undefined,
    // 128 active streams × 64 KiB = 8 MiB of application download buffers.
    maxActive: integer("SPEEDTEST_MAX_ACTIVE", 128, 65_535),
    // Bounded process-local abuse ledger; 4096 small records fit roughly within 1 MiB.
    maxPeers: integer("SPEEDTEST_MAX_PEERS", 4_096, 1_000_000),
    maxPacketsPerSecond: integer("SPEEDTEST_UDP_PACKETS_PER_SECOND", 4_096, 1_000_000),
    trustedProxies,
  };
}
