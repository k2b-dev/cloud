import type { z } from "zod";
import { CAPABILITY_MAX_RESULT_BYTES, capabilityResultSchema } from "../contracts/capabilities";
import { geoContract } from "../contracts/geo";
import { geoMapContract } from "../contracts/geo-map";
import { geoRouteContract } from "../contracts/geo-route";
import { GEO_TIMEOUT_MS } from "../services/geo/bucket";
import { readCapabilityResponse } from "./response";
import { type CapabilityCaller, invokeCapabilityWithDataSchema } from "./server";
import { coreOrigin, unavailable } from "./server-invoke";
import { combineCapabilitySignals } from "./signals";

const anonymousAutocomplete = async (input: z.input<typeof geoContract.autocomplete.input>, caller: CapabilityCaller) => {
  try {
    const signal = combineCapabilitySignals(caller.signal, AbortSignal.timeout(GEO_TIMEOUT_MS.autocomplete));
    const request = new Request(new URL("/api/_internal/geo/v1/autocomplete", await coreOrigin(true)), {
      method: "POST",
      headers: { "content-type": "application/json", ...(caller.locale ? { "x-cloud-locale": caller.locale } : {}) },
      body: JSON.stringify(input),
      signal,
    });
    return await readCapabilityResponse(
      await (caller.transport ?? fetch)(request),
      capabilityResultSchema(geoContract.autocomplete.data, { consumer: true }),
      CAPABILITY_MAX_RESULT_BYTES,
      signal,
      caller.consumeResponseBytes,
    );
  } catch (cause) {
    return unavailable(cause, undefined, caller.locale ?? undefined);
  }
};

/** Autocomplete defaults to anonymous internal Core access; other operations require a caller. */
export const geoClient = {
  mapStyle: (input: z.input<typeof geoMapContract.style.input>, caller: CapabilityCaller) =>
    invokeCapabilityWithDataSchema(
      { kind: "query", appId: "core", capabilityId: geoMapContract.style.id, input },
      geoMapContract.style.data,
      caller,
    ),
  calculateRoute: (input: z.input<typeof geoRouteContract.calculateRoute.input>, caller: CapabilityCaller) =>
    invokeCapabilityWithDataSchema(
      { kind: "query", appId: "core", capabilityId: geoRouteContract.calculateRoute.id, input },
      geoRouteContract.calculateRoute.data,
      caller,
    ),
  updateRoute: (input: z.input<typeof geoRouteContract.updateRoute.input>, caller: CapabilityCaller) =>
    invokeCapabilityWithDataSchema(
      { kind: "query", appId: "core", capabilityId: geoRouteContract.updateRoute.id, input },
      geoRouteContract.updateRoute.data,
      caller,
    ),
  autocomplete: (input: z.input<typeof geoContract.autocomplete.input>, caller?: CapabilityCaller) =>
    caller !== undefined
      ? invokeCapabilityWithDataSchema(
          { kind: "query", appId: "core", capabilityId: geoContract.autocomplete.id, input },
          geoContract.autocomplete.data,
          caller,
        )
      : anonymousAutocomplete(input, {}),
  geocode: (input: z.input<typeof geoContract.geocode.input>, caller: CapabilityCaller) =>
    invokeCapabilityWithDataSchema(
      { kind: "query", appId: "core", capabilityId: geoContract.geocode.id, input },
      geoContract.geocode.data,
      caller,
    ),
  reverse: (input: z.input<typeof geoContract.reverse.input>, caller: CapabilityCaller) =>
    invokeCapabilityWithDataSchema(
      { kind: "query", appId: "core", capabilityId: geoContract.reverse.id, input },
      geoContract.reverse.data,
      caller,
    ),
  searchPlaces: (input: z.input<typeof geoContract.searchPlaces.input>, caller: CapabilityCaller) =>
    invokeCapabilityWithDataSchema(
      { kind: "query", appId: "core", capabilityId: geoContract.searchPlaces.id, input },
      geoContract.searchPlaces.data,
      caller,
    ),
  availability: (caller: CapabilityCaller) =>
    invokeCapabilityWithDataSchema(
      { kind: "query", appId: "core", capabilityId: geoContract.availability.id, input: {} },
      geoContract.availability.data,
      caller,
    ),
};
