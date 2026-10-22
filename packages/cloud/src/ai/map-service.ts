import { geoClient } from "../capabilities/geo-client";
import type { CapabilityCaller } from "../capabilities/server";
import type { CapabilityClientResult } from "../capabilities/types";
import { GeoAddressSchema, type GeoPlaceSearchInput } from "../contracts/geo";
import type { GeoRouteChanges, GeoRoutePlan } from "../contracts/geo-route";
import { mapMessages } from "./chat/map-messages";
import { type AiMap, type AiMapCommand, AiMapSchema } from "./map-contracts";
import { AiMapConflict, type AiMapStored } from "./map-store";

export class AiMapGeoError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}
const data = <T>(result: CapabilityClientResult<T>): T => {
  if (!result.ok) throw new AiMapGeoError(result.error.code, result.error.details ?? {});
  return result.data.data;
};
export type AiMapGeo = Pick<typeof geoClient, "availability" | "geocode" | "searchPlaces" | "calculateRoute" | "updateRoute">;
export type AiMapContext = {
  caller: CapabilityCaller;
  geo?: AiMapGeo;
  timeZone?: string;
  placeReferences?: "marks";
  turnId?: string;
  callId?: string;
  now?: () => Date;
  onPrepared?: (value: AiMapStored) => Promise<void>;
  verifyWeb: (url: string) => Promise<boolean>;
};
const placeById = (map: AiMap, id: string, ctx: AiMapContext) => {
  const exact = () => [...(map.picker ?? []), ...map.groups.flatMap((g) => g.places)].find((p) => p.id === id);
  const mark = () =>
    (/^pick-[1-5]$/.test(id) ? map.picker?.[Number(id.slice(5)) - 1] : undefined) ??
    (/^[1-9][0-9]?$/.test(id) ? map.groups[0]?.places[Number(id) - 1] : undefined) ??
    (/^[A-T]$/.test(id) ? map.groups[1]?.places[id.charCodeAt(0) - 65] : undefined);
  const place = ctx.placeReferences === "marks" ? mark() : exact();
  if (!place) throw new Error("MAP_PLACE_NOT_FOUND");
  return place;
};

const readWeb = async (map: AiMap, web: AiMap["web"], ctx: AiMapContext) => {
  const resolved = web.map((item) => ({ ...item, placeId: placeById(map, item.placeId, ctx).id }));
  for (const item of resolved) {
    if (!/^https?:\/\//.test(item.url) || !(await ctx.verifyWeb(item.url))) throw new Error("MAP_WEB_SOURCE_NOT_READ");
  }
  const fresh = new Set(resolved.map((w) => w.placeId));
  return [...map.web.filter((w) => !fresh.has(w.placeId)), ...resolved].slice(-40);
};
const searchPlaces = async (map: AiMap, search: Extract<AiMapCommand, { type: "places" }>["search"], ctx: AiMapContext, limit = 20) => {
  const geo = ctx.geo ?? geoClient;
  let input: GeoPlaceSearchInput;
  if (search.along) {
    if (!map.route) throw new Error("MAP_ROUTE_REQUIRED");
    input = { categories: search.categories, along: { polyline6: map.route.polyline6, ...search.along }, limit };
  } else {
    const point = search.placeId
      ? placeById(map, search.placeId, ctx).point
      : search.near
        ? map.searchAddress?.text === search.near
          ? map.searchAddress.address.point
          : data(await geo.geocode({ text: search.near }, ctx.caller)).address.point
        : map.groups[0]?.places[0]?.point;
    if (!point) throw new Error("MAP_LOCATION_REQUIRED");
    input = {
      categories: search.categories,
      area: { type: "circle", point, radiusMeters: search.radiusMeters ?? 2000 },
      near: point,
      limit,
    };
  }
  return data(await geo.searchPlaces(input, ctx.caller)).places;
};
const titleOfChange = (changes: GeoRouteChanges, ctx: AiMapContext) => {
  const t = mapMessages(ctx.caller.locale ?? "en");
  const de = ctx.caller.locale?.startsWith("de");
  if (changes.type === "insert") return de ? `${changes.stop.label ?? "Stopp"} einfügen` : `Insert ${changes.stop.label ?? "stop"}`;
  if (changes.type === "optimize") return de ? "Neue Reihenfolge übernehmen" : "Accept new order";
  if (changes.type === "move") return de ? "Stopp verschieben" : "Move stop";
  return `${changes.leg ? (de ? "Etappe" : "Leg") : t.whole}${changes.options.avoid?.length ? `${de ? " ohne " : " avoiding "}${changes.options.avoid.map((a) => t[a]).join(", ")}` : de ? " neu rechnen" : " recalculate"}`;
};
export async function createAiMap(
  input: { conversationId: string; command: AiMapCommand; id?: string },
  ctx: AiMapContext,
): Promise<AiMapStored> {
  const command = input.command;
  if (command.type !== "places" && command.type !== "route") throw new Error("MAP_CREATE_REQUIRED");
  const availability = data(await (ctx.geo ?? geoClient).availability(ctx.caller));
  const map: AiMap = {
    id: input.id ?? crypto.randomUUID(),
    conversationId: input.conversationId,
    revision: 1,
    title: command.type === "places" ? command.search.title : command.title,
    kind: command.type === "places" ? "places" : "route",
    availability,
    timeZone: ctx.timeZone,
    viewedAt: (ctx.now?.() ?? new Date()).toISOString(),
    originCallId: ctx.callId,
    groups: [],
    web: [],
  };
  if (availability.configured && !availability.cloud.exhausted && !availability.person.exhausted && ctx.onPrepared) {
    map.pending = true;
    map.retryUsesMarks = ctx.placeReferences === "marks";
    map.pendingTurnId = ctx.turnId;
    await ctx.onPrepared({ map, retry: command });
    return applyAiMap({ map }, command, ctx);
  }
  return applyAiMap({ map }, command, ctx, false);
}

/** Pure domain transition around the existing permission-aware Geo client. The store applies a revision CAS afterwards. */
export async function applyAiMap(stored: AiMapStored, input: AiMapCommand, ctx: AiMapContext, increment = true): Promise<AiMapStored> {
  if (input.type === "retry") ctx = { ...ctx, placeReferences: stored.map.retryUsesMarks ? "marks" : undefined };
  const geo = ctx.geo ?? geoClient;
  let map = structuredClone(stored.map);
  if (increment) map.revision++;
  let command = input.type === "retry" ? stored.retry : input;
  if (stored.map.issue?.code === "GEO_COST_OVERRUN" && !["accept", "discard", "undo", "describe"].includes(input.type)) {
    const allowance =
      input.type === "retry" || input.type === "preview" || input.type === "route" ? input.distanceAllowanceMeters : undefined;
    if (
      !allowance ||
      allowance <=
        (stored.map.issue?.distanceAllowanceMeters ??
          stored.map.route?.distanceAllowanceMeters ??
          stored.map.plan?.distanceAllowanceMeters ??
          500000)
    )
      throw new Error("MAP_NEW_ALLOWANCE_REQUIRED");
  }
  if (input.type === "retry" && input.distanceAllowanceMeters && command && (command.type === "preview" || command.type === "route"))
    command = { ...command, distanceAllowanceMeters: input.distanceAllowanceMeters };
  if (!command || command.type === "retry") throw new Error("MAP_NOTHING_TO_RETRY");
  const retry = command;
  if (stored.map.issue?.code !== "GEO_COST_OVERRUN" || !["accept", "discard", "undo", "describe"].includes(command.type)) delete map.issue;
  delete map.pending;
  delete map.pendingTurnId;
  try {
    // Local reversal and commit do not call the provider. Every expensive step checks current availability first.
    if (!["accept", "discard", "undo", "describe"].includes(command.type)) {
      map.availability = data(await geo.availability(ctx.caller));
      if (!map.availability.configured) throw new AiMapGeoError("GEO_NOT_CONFIGURED");
      for (const scope of ["cloud", "person"] as const)
        if (map.availability[scope].exhausted)
          throw new AiMapGeoError("GEO_BUDGET_EXHAUSTED", { scope, resetsAt: map.availability[scope].resetsAt });
    }
    if (command.type === "places" || command.type === "search") {
      map.lastSearch = command.search;
      const places = await searchPlaces(map, command.search, ctx, command.type === "search" && command.insert ? 5 : 20);
      if (command.type === "search" && command.insert) map.picker = places;
      else {
        const group = { title: command.search.title, places };
        map.groups = command.type === "places" || !map.groups[0] ? [group] : [map.groups[0], group];
        const ids = new Set(map.groups.flatMap((g) => g.places.map((p) => p.id)));
        map.web = map.web.filter((w) => ids.has(w.placeId));
      }
      map.selectionId = places[0]?.id;
      if (command.web) map.web = await readWeb(map, command.web, ctx);
    } else if (command.type === "repair") {
      if (!map.plan || map.route || !map.plan.stops.some((s) => s.id === command.stopId)) throw new Error("MAP_STOP_NOT_FOUND");
      map.plan.stops = map.plan.stops.map((s) =>
        s.id === command.stopId ? { id: s.id, label: command.address, address: { text: command.address } } : s,
      );
      map.route = data(await geo.calculateRoute({ plan: map.plan }, ctx.caller)).route;
      delete map.candidates;
      delete map.ambiguousStopId;
    } else if (command.type === "location") {
      if (map.route) throw new Error("MAP_ROUTE_EDIT_REQUIRES_PREVIEW");
      const place = placeById(map, command.destinationId, ctx);
      map.kind = "route";
      map.title = place.name.slice(0, 160);
      map.plan = {
        stops: [
          { id: "location", label: ctx.caller.locale?.startsWith("de") ? "Mein Standort" : "My location", point: command.point },
          { id: "destination", label: place.name, point: place.point },
        ],
      };
      map.route = data(await geo.calculateRoute({ plan: map.plan }, ctx.caller)).route;
    } else if (command.type === "route") {
      if (map.route) throw new Error("MAP_ROUTE_EDIT_REQUIRES_PREVIEW");
      const plan: GeoRoutePlan = {
        stops: command.stops.map((stop) => {
          if (stop.placeId) {
            const p = placeById(map, stop.placeId, ctx);
            return { id: stop.id, label: stop.label ?? p.name, point: p.point };
          }
          if (!stop.address) throw new Error("MAP_STOP_ADDRESS_REQUIRED");
          return { id: stop.id, label: stop.label ?? stop.address, address: { text: stop.address } };
        }),
        options: command.options,
        distanceAllowanceMeters: command.distanceAllowanceMeters,
      };
      map.plan = plan;
      map.kind = "route";
      map.title = command.title;
      map.route = data(await geo.calculateRoute({ plan }, ctx.caller)).route;
      delete map.preview;
      delete map.candidates;
      delete map.ambiguousStopId;
    } else if (command.type === "choose") {
      const address = map.candidates?.[command.index];
      if (!address) throw new Error("MAP_CANDIDATE_NOT_FOUND");
      if (!map.plan || !map.ambiguousStopId) {
        if (stored.retry?.type !== "places" && stored.retry?.type !== "search") throw new Error("MAP_CANDIDATE_NOT_FOUND");
        const search = stored.retry.search;
        if (!search.near) throw new Error("MAP_CANDIDATE_NOT_FOUND");
        map.searchAddress = { text: search.near, address };
        map.candidates = undefined;
        const next = await applyAiMap({ map }, stored.retry, { ...ctx, placeReferences: map.retryUsesMarks ? "marks" : undefined }, false);
        return next;
      }
      map.plan.stops = map.plan.stops.map((s) =>
        s.id === map.ambiguousStopId ? { id: s.id, label: address.formatted, point: address.point } : s,
      );
      map.route = data(await geo.calculateRoute({ plan: map.plan }, ctx.caller)).route;
      delete map.candidates;
      delete map.ambiguousStopId;
    } else if (command.type === "preview") {
      if (!map.route) throw new Error("MAP_ROUTE_REQUIRED");
      let changes: GeoRouteChanges;
      if (command.change.type === "insert") {
        const p = placeById(map, command.change.placeId, ctx);
        changes = {
          type: "insert",
          stop: { id: crypto.randomUUID(), label: p.name, point: p.point },
          afterStopId: command.change.afterStopId,
        };
      } else changes = command.change;
      const result = data(
        await geo.updateRoute({ route: map.route, changes, distanceAllowanceMeters: command.distanceAllowanceMeters }, ctx.caller),
      );
      map.preview = { result, changes, title: titleOfChange(changes, ctx).slice(0, 160) };
      delete map.picker;
    } else if (command.type === "accept") {
      if (!map.preview || !map.route) throw new AiMapConflict();
      map.undo = { route: map.route, title: map.preview.title };
      map.route = map.preview.result.route;
      map.receipt = { title: map.preview.title, at: (ctx.now?.() ?? new Date()).toISOString() };
      delete map.preview;
    } else if (command.type === "discard") {
      delete map.preview;
      delete map.picker;
    } else if (command.type === "undo") {
      if (!map.undo) throw new AiMapConflict();
      map.route = map.undo.route;
      delete map.undo;
      delete map.preview;
      map.receipt = {
        title: ctx.caller.locale?.startsWith("de") ? "Rückgängig gemacht" : "Undone",
        at: (ctx.now?.() ?? new Date()).toISOString(),
      };
    } else if (command.type === "describe") map.web = await readWeb(map, command.web, ctx);
    if (!map.issue) delete map.retryUsesMarks;
    return { map: AiMapSchema.parse(map), ...(map.issue ? { retry: stored.retry } : {}) };
  } catch (cause) {
    if (!(cause instanceof AiMapGeoError)) throw cause;
    const d = cause.details;
    map.retryUsesMarks = ctx.placeReferences === "marks";
    const candidates = GeoAddressSchema.array().max(5).safeParse(d.candidates);
    if (cause.code === "GEO_ADDRESS_AMBIGUOUS" && candidates.success) {
      map.candidates = candidates.data;
      map.ambiguousStopId = typeof d.stopId === "string" ? d.stopId : undefined;
    }
    map.issue = AiMapSchema.shape.issue.unwrap().parse({
      code: cause.code,
      ...(cause.code === "GEO_COST_OVERRUN"
        ? {
            distanceAllowanceMeters:
              command.type === "preview" || command.type === "route"
                ? (command.distanceAllowanceMeters ?? map.route?.distanceAllowanceMeters ?? map.plan?.distanceAllowanceMeters ?? 500000)
                : (map.route?.distanceAllowanceMeters ?? map.plan?.distanceAllowanceMeters ?? 500000),
          }
        : {}),
      ...(d.scope === "person" || d.scope === "cloud" ? { scope: d.scope } : {}),
      ...(typeof d.resetsAt === "string" ? { resetsAt: d.resetsAt } : {}),
      ...(typeof d.retryAfterSeconds === "number" ? { retryAfterSeconds: d.retryAfterSeconds } : {}),
      ...(d.costs && typeof d.costs === "object" ? { costs: d.costs } : {}),
    });
    return { map: AiMapSchema.parse(map), retry };
  }
}
