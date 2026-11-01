import type { GeoAvailabilityData } from "@k2b/cloud/contracts/geo";
import { type AuthContext, geoClient, getLocale } from "@k2b/cloud/server";
import type { Context } from "hono";

/** Core sees the person's own credential, so geo calls run as that person and spend their budget. */
export const geoCaller = <E extends AuthContext>(c: Context<E>) => ({
  cookie: c.req.header("Cookie"),
  authorization: c.req.header("Authorization"),
  requestId: c.req.header("X-Request-Id") ?? null,
  traceparent: c.req.header("traceparent"),
  tracestate: c.req.header("tracestate"),
  locale: getLocale(c),
  signal: c.req.raw.signal,
});

/** Setup and budget for the SSR snapshot. Without an answer the page renders as configured and recovers per address. */
export const loadGeoAvailability = async <E extends AuthContext>(c: Context<E>): Promise<GeoAvailabilityData | undefined> => {
  const result = await geoClient.availability(geoCaller(c)).catch(() => null);
  return result?.ok ? result.data.data : undefined;
};
