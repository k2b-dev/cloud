import { redis } from "@k2b/cloud";

const PROVIDER_OPERATIONS_PER_SECOND = 5;
const PROVIDER_SLOT_INTERVAL_MS = Math.ceil(1_000 / PROVIDER_OPERATIONS_PER_SECOND);
const PROVIDER_SLOT_TTL_MS = 60_000;

const reserveProviderSlotScript = `
  local time = redis.call("TIME")
  local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
  local nextAt = tonumber(redis.call("GET", KEYS[1]) or "0")
  local slotAt = math.max(now, nextAt)
  redis.call("SET", KEYS[1], slotAt + tonumber(ARGV[1]), "PX", ARGV[2])
  return slotAt - now
`;

const wait = async (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (delayMs <= 0) return;
  if (!signal) {
    await Bun.sleep(delayMs);
    return;
  }
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

/**
 * Smooths provider work per remote mailbox across every Mail runtime process.
 *
 * Callers reserve one short slot while holding the provider operation mutex,
 * so bursts are spread out without keeping hundreds of jobs asleep at once.
 */
export const waitForMailProviderSlot = async (remoteResourceId: string, signal?: AbortSignal): Promise<void> => {
  const delayMs = Number(
    await redis.send("EVAL", [
      reserveProviderSlotScript,
      "1",
      `mail:provider-pacer:${remoteResourceId}`,
      String(PROVIDER_SLOT_INTERVAL_MS),
      String(PROVIDER_SLOT_TTL_MS),
    ]),
  );
  await wait(delayMs, signal);
};
