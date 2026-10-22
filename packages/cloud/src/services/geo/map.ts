import { mapAttribution } from "@k2b/ui";
import { GEO_MAP_MAX_ZOOM, GEO_MAX_TILE_BYTES, GeoMapStyleInputSchema } from "../../contracts/geo-map";
import { EMPTY_NETWORK_ALLOWLIST } from "../../shared/network-address";
import { createAllowedNetworkFetch } from "../allowed-network-fetch";
import { createGeoBucket, GEO_TIMEOUT_MS } from "./bucket";
import { GeoError } from "./errors";
import { type GeoFetch, GeoProviderError, geoNeverSent } from "./geoapify";
import { createGeoLedger } from "./ledger";
import { type GeoContext, geoIdentity } from "./service";
import { type GeoConfig, geoPlan, readGeoConfig } from "./settings";

const guardedFetch = createAllowedNetworkFetch(EMPTY_NETWORK_ALLOWLIST);

export const createGeoMapService = (
  options: {
    config?: () => Promise<GeoConfig>;
    now?: () => Date;
    fetch?: GeoFetch;
    bucket?: ReturnType<typeof createGeoBucket>;
    ledger?: ReturnType<typeof createGeoLedger>;
  } = {},
) => {
  const config = options.config ?? readGeoConfig;
  const now = options.now ?? (() => new Date());
  const bucket = options.bucket ?? createGeoBucket();
  const ledger = options.ledger ?? createGeoLedger();
  const configured = async (context: GeoContext) => {
    geoIdentity(context);
    const settings = await config();
    if (!settings.apiKey.trim()) throw new GeoError("GEO_NOT_CONFIGURED");
    return settings;
  };
  return {
    async style(input: { theme?: "light" | "dark" }, context: GeoContext) {
      await configured(context);
      const parsed = GeoMapStyleInputSchema.safeParse(input);
      if (!parsed.success) throw new GeoError("GEO_UNSUPPORTED_OPTION");
      const locale = new Intl.Locale(context.locale ?? "en").language;
      return { styleUrl: `/api/geo/style?theme=${parsed.data.theme}&locale=${locale}`, attribution: [...mapAttribution] };
    },
    async tile(input: { z: number; x: number; y: number }, context: GeoContext): Promise<Uint8Array<ArrayBuffer>> {
      const settings = await configured(context);
      const identity = geoIdentity(context);
      const { z, x, y } = input;
      if (![z, x, y].every(Number.isInteger) || z < 0 || z > GEO_MAP_MAX_ZOOM || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z)
        throw new GeoError("GEO_UNSUPPORTED_OPTION");
      const deadline = AbortSignal.timeout(GEO_TIMEOUT_MS.tiles);
      const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
      const release = await bucket.acquire("tiles", geoPlan(settings).rps * 4);
      let reservation: Awaited<ReturnType<typeof ledger.reserve>> | undefined;
      let charge: "none" | "known" | "unknown" = "none";
      try {
        signal.throwIfAborted();
        reservation = await ledger.reserve(identity.accessSubject, settings, 250, "tiles", now());
        const url = new URL(`/v1/tile/osm-bright/${z}/${x}/${y}.pbf`, "https://api-eu.geoapify.com");
        let response: Response | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          signal.throwIfAborted();
          charge = "unknown";
          try {
            response = await (options.fetch ?? guardedFetch)(url, {
              headers: { "x-api-key": settings.apiKey, accept: "application/x-protobuf" },
              credentials: "omit",
              redirect: "error",
              signal,
            });
            break;
          } catch (cause) {
            if (!signal.aborted && geoNeverSent(cause)) {
              charge = "none";
              if (attempt === 0) continue;
            }
            throw new GeoProviderError("GEO_PROVIDER_FAILED", charge);
          }
        }
        if (!response) throw new GeoProviderError("GEO_PROVIDER_FAILED", charge);
        charge = "known";
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new GeoProviderError(
            response.status === 429 ? "GEO_BUSY" : "GEO_PROVIDER_FAILED",
            charge,
            [401, 403].includes(response.status),
          );
        }
        const type = response.headers.get("content-type")?.split(";")[0]?.trim();
        if (
          !type ||
          !["application/x-protobuf", "application/vnd.mapbox-vector-tile", "application/octet-stream"].includes(type) ||
          Number(response.headers.get("content-length")) > GEO_MAX_TILE_BYTES
        ) {
          void response.body?.cancel().catch(() => {});
          throw new GeoProviderError("GEO_PROVIDER_FAILED", charge);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new GeoProviderError("GEO_PROVIDER_FAILED", charge);
        const abort = () => {
          void reader.cancel().catch(() => {});
        };
        signal.addEventListener("abort", abort, { once: true });
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          if (signal.aborted) abort();
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > GEO_MAX_TILE_BYTES) {
              abort();
              throw new GeoProviderError("GEO_PROVIDER_FAILED", charge);
            }
            chunks.push(next.value);
          }
          signal.throwIfAborted();
        } finally {
          signal.removeEventListener("abort", abort);
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        // Never forward an echoed credential, including one spanning streamed chunks.
        if (Buffer.from(bytes).includes(Buffer.from(settings.apiKey))) throw new GeoProviderError("GEO_PROVIDER_FAILED", charge);
        return bytes;
      } catch (cause) {
        if (reservation && charge === "none") {
          try {
            await ledger.settle(reservation, 0);
          } catch {
            charge = "unknown";
          }
        }
        if (reservation && charge !== "none" && (!(cause instanceof GeoError) || signal.aborted)) charge = "unknown";
        const error = cause instanceof GeoError ? cause : new GeoError("GEO_PROVIDER_FAILED");
        const transition =
          cause instanceof GeoProviderError && cause.keyRejected
            ? "provider_key_rejected"
            : error.code === "GEO_BUDGET_EXHAUSTED" && error.details.scope === "cloud"
              ? "monthly_budget_exhausted"
              : null;
        if (transition)
          await ledger.recordTransition(transition, settings.timezone, { ...context, ...identity }, now()).catch(() => {
            console.error("[geo] Map audit transition could not be recorded", { event: transition });
          });
        if (error.code === "GEO_PROVIDER_FAILED" || error.code === "GEO_BUSY")
          throw new GeoError(error.code, {
            ...error.details,
            costs: {
              settledCredits: reservation && charge === "known" ? 0.25 : 0,
              unknownCredits: reservation && charge === "unknown" ? 0.25 : 0,
            },
          });
        throw error;
      } finally {
        await release();
      }
    },
  };
};
export const coreGeoMap = createGeoMapService();
