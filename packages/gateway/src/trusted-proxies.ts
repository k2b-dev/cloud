import { setTimeout as delay } from "node:timers/promises";
import { env } from "@k2b/cloud/config";
import { loadCache, read } from "@k2b/cloud/services/settings";
import { trustedProxySet } from "@k2b/cloud/services/settings/validation";

// Match the existing five-minute NATS startup budget while Core creates shared tables.
const SETTINGS_STARTUP_BUDGET_MS = 5 * 60_000;
const startupRetryable = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const code =
    "errno" in error && typeof error.errno === "string" ? error.errno : "code" in error && typeof error.code === "string" ? error.code : "";
  return (
    ["42P01", "3F000", "57P03", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code) ||
    code.startsWith("08") ||
    code.startsWith("ERR_POSTGRES_CONNECTION")
  );
};
const readStartupState = async (signal: AbortSignal) => {
  for (;;) {
    signal.throwIfAborted();
    try {
      await loadCache();
      return await read("gateway.trusted_proxies");
    } catch (error) {
      if (!startupRetryable(error)) throw error;
      console.warn("[gateway] Settings database or schema is not ready; waiting for Core before serving HTTP.");
      await delay(1_000, undefined, { signal });
    }
  }
};
export const loadTrustedProxies = async (signal = AbortSignal.timeout(SETTINGS_STARTUP_BUDGET_MS)) => {
  let onAbort: (() => void) | undefined;
  const state = await Promise.race([
    readStartupState(signal),
    new Promise<never>((_, reject) => {
      onAbort = () =>
        reject(
          new Error(
            "Gateway settings were not ready within the startup budget; HTTP remains closed. Check Core and the settings database.",
            { cause: signal.reason },
          ),
        );
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }),
  ]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
  const repair = `Repair with cld admin settings set gateway.trusted_proxies --value '["127.0.0.0/8","::1/128","10.0.0.0/8","172.16.0.0/12","192.168.0.0/16","fc00::/7"]' --replace-unreadable --yes, then restart the gateway. Choose your proxy's exact addresses or subnet to narrow trust.`;
  if (state.stored === "none") {
    const bootstrap = env.$readPresent("GATEWAY_TRUSTED_PROXIES");
    if (bootstrap !== undefined) {
      try {
        trustedProxySet(bootstrap);
      } catch {
        throw new Error(`Invalid GATEWAY_TRUSTED_PROXIES bootstrap. Correct or remove it before restarting the gateway. ${repair}`);
      }
    }
  }
  if (state.stored === "unreadable") throw new Error(`Cannot read or validate gateway.trusted_proxies. ${repair}`);
  if (!Array.isArray(state.value) || !state.value.every((entry): entry is string => typeof entry === "string"))
    throw new Error(`Invalid gateway.trusted_proxies. ${repair}`);
  try {
    return trustedProxySet(state.value);
  } catch {
    throw new Error(`Invalid gateway.trusted_proxies. ${repair}`);
  }
};
