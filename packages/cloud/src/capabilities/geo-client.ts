import type { z } from "zod";
import { geoContract } from "../contracts/geo";
import { type CapabilityCaller, invokeCapabilityWithDataSchema } from "./server";

/** Calls Core using the caller's interactive identity, invocation transport, or durable mandate. */
export const geoClient = {
  autocomplete: (input: z.input<typeof geoContract.autocomplete.input>, caller: CapabilityCaller) =>
    invokeCapabilityWithDataSchema(
      { kind: "query", appId: "core", capabilityId: geoContract.autocomplete.id, input },
      geoContract.autocomplete.data,
      caller,
    ),
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
