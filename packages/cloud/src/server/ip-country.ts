import { isIP } from "node:net";
import { z } from "zod";
import { getProcessApplicationId } from "../_internal/process-identity";
import { env } from "../config/env";
import { DBIP_ATTRIBUTION, type IpCountryResult } from "../contracts/geoip";
import { sendAppRequest } from "../services/identity/app-request";
import { coreOrigin } from "../services/identity/core-origin";
import { logger } from "../services/logging";
import { publicClientAddress } from "./request-context/address";

export { DBIP_ATTRIBUTION, type IpCountryResult } from "../contracts/geoip";

const Result = z.object({
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  available: z.boolean(),
  attribution: z
    .object({
      text: z.literal(DBIP_ATTRIBUTION.text),
      url: z.literal(DBIP_ATTRIBUTION.url),
      license: z.literal(DBIP_ATTRIBUTION.license),
      licenseUrl: z.literal(DBIP_ATTRIBUTION.licenseUrl),
    })
    .nullable(),
});
const unavailable = (): IpCountryResult => ({ country: null, available: false, attribution: null });
let failureLogged = false;

/** Resolve only a country through Core. Never retain the address or send it outside this installation. */
export const ipCountry = async (ip: string): Promise<IpCountryResult> => {
  const controller = new AbortController();
  // Optional enrichment gets a two-second total budget, including signing and response consumption.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Country lookup deadline exceeded"));
    }, 2_000);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const appId = getProcessApplicationId();
        // This route accepts app proofs only; do not fall back to a legacy workload token.
        if (!appId || !env.CLOUD_APP_KEY) return unavailable();
        const address = ip.length <= 45 && isIP(ip) ? publicClientAddress(ip) : null;
        const response = await sendAppRequest(
          new Request(new URL("/api/_internal/ip-country", await coreOrigin(true)), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Empty input still reads availability without transmitting a private or invalid address.
            body: JSON.stringify({ ip: address ?? "" }),
            signal: controller.signal,
          }),
          { appId },
        );
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new Error("Country lookup unavailable");
        }
        // A result is at most 256 ASCII bytes with the fixed attribution; leave room for JSON whitespace.
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Country lookup response missing");
        try {
          const bytes = new Uint8Array(512);
          let size = 0;
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (size + chunk.value.length > bytes.length) throw new Error("Country lookup response too large");
            bytes.set(chunk.value, size);
            size += chunk.value.length;
          }
          return Result.parse(JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))));
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      })(),
    ]);
  } catch {
    if (!failureLogged) {
      failureLogged = true;
      try {
        logger("ip-country").warn("Country lookup unavailable; continuing without a country");
      } catch {}
    }
    return unavailable();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};
