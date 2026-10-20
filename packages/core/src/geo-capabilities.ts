import { type CapabilityExecutionContext, defineCapabilities, geoContract } from "@k2b/cloud/contracts";
import { coreGeo } from "@k2b/cloud/services";
import { GeoError } from "@k2b/cloud/services/geo/errors";
import { geoCapabilityMessages } from "./geo-capability-messages";
import { geoCapabilityPresentation } from "./geo-capability-presentation";

const run = async <T>(context: CapabilityExecutionContext, call: () => Promise<T>) => {
  try {
    return { ok: true as const, data: { data: await call() } };
  } catch (cause) {
    const error =
      cause instanceof GeoError ? cause : new GeoError("GEO_PROVIDER_FAILED", { costs: { settledCredits: 0, unknownCredits: 0 } });
    return {
      ok: false as const,
      error: { code: error.code, message: geoCapabilityMessages(context.locale)[error.code], status: error.status, details: error.details },
    };
  }
};
export const geoCapabilities = defineCapabilities({
  protocolVersion: 2,
  presentation: { baseLocale: "en", translations: { de: { queries: geoCapabilityPresentation } } },
  queries: {
    "address.autocomplete": {
      title: "Suggest addresses",
      description:
        "Return up to 5 address suggestions for 3–300 characters. Results carry provenance; keep attribution. Cache hits are free, otherwise costs credits within the operator budget.",
      input: geoContract.autocomplete.input,
      data: geoContract.autocomplete.data,
      openWorld: true,
      run: (input, context) => run(context, () => coreGeo.autocomplete(input, context)),
    },
    "address.geocode": {
      title: "Locate an address",
      description:
        "Locate address text up to 300 characters or structured fields up to 200 each. Requests 5 provider candidates; confidence ≥ 0.5 is plausible. Returns one address, up to 5 candidates on ambiguity, or not found. Results carry provenance; keep attribution. Costs credits within the operator budget; cache hits are free.",
      input: geoContract.geocode.input,
      data: geoContract.geocode.data,
      openWorld: true,
      run: (input, context) => run(context, () => coreGeo.geocode(input, context)),
    },
    "address.reverse": {
      title: "Find an address at coordinates",
      description:
        "Return an address at latitude/longitude. Results carry provenance; keep attribution. Costs credits within the operator budget; cache hits are free.",
      input: geoContract.reverse.input,
      data: geoContract.reverse.data,
      openWorld: true,
      run: (input, context) => run(context, () => coreGeo.reverse(input, context)),
    },
    "place.search": {
      title: "Search places",
      description:
        "Return up to 20 places in 1–5 categories near a point, in a bbox/circle, or along polyline6. Along: at most 200 km per window, buffer 100–5,000 m (default 1,000). Includes available raw OSM opening hours, route position and straight-line distance. Results carry provenance; keep attribution. Costs credits within the operator budget; cache hits are free.",
      input: geoContract.searchPlaces.input,
      data: geoContract.searchPlaces.data,
      openWorld: true,
      run: (input, context) => run(context, () => coreGeo.searchPlaces(input, context)),
    },
    "geo.availability": {
      title: "Check geo availability",
      description:
        "Return configuration status and the caller's person and Cloud budget exhaustion/reset times. Free: no provider call or budget charge.",
      input: geoContract.availability.input,
      data: geoContract.availability.data,
      openWorld: false,
      run: (_input, context) => run(context, () => coreGeo.availability(context)),
    },
  },
});
