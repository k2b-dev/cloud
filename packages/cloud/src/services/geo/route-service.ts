import { z } from "zod";
import { GeoGeocodeDataSchema, type GeoGeocodeInput } from "../../contracts/geo";
import {
  GeoRouteCalculateDataSchema,
  type GeoRouteCalculateInput,
  GeoRouteCalculateInputSchema,
  type GeoRouteLeg,
  GeoRouteLegSchema,
  type GeoRouteOptions,
  type GeoRouteResolvedStop,
  GeoRouteResolvedStopSchema,
  type GeoRouteStop,
  type GeoRouteUpdateData,
  GeoRouteUpdateDataSchema,
  type GeoRouteUpdateInput,
  GeoRouteUpdateInputSchema,
} from "../../contracts/geo-route";
import { geoCacheKey, normalizeGeoInput } from "./cache";
import { GeoError, limitExceeded } from "./errors";
import type { GeoapifyAdapter } from "./geoapify";
import { geoDistance } from "./polyline";
import {
  type GeoRouteCallPricing,
  type GeoRouteChainCall,
  type GeoRouteChainDependencies,
  reserveRouteCall,
  runGeoRouteChain,
} from "./route-chain";
import {
  assembleRoute,
  insertionGaps,
  routeOptions,
  routeSummary,
  sameRouteOptions,
  validateRoutePlan,
  validateRouteStops,
  validateSavedRoute,
  walkDistance,
} from "./route-plan";
import type { GeoContext } from "./service";
import type { GeoConfig } from "./settings";

const providerData = z
  .object({
    stops: z.array(GeoRouteResolvedStopSchema).min(2).max(26),
    legs: z.array(GeoRouteLegSchema).min(1).max(25),
    distanceMeters: z.number().nonnegative(),
  })
  .strict();
type RouteCall = GeoRouteChainCall;
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    if (issue.code === "too_big" || issue.code === "too_small") {
      const actual = issue.path.reduce<unknown>(
        (value, key) => (value && typeof value === "object" ? Reflect.get(value, key) : undefined),
        input,
      );
      limitExceeded(
        issue.path.join("."),
        Number(issue.code === "too_big" ? issue.maximum : issue.minimum),
        Array.isArray(actual) || typeof actual === "string" ? actual.length : typeof actual === "number" ? actual : 0,
      );
    }
    throw new GeoError("GEO_UNSUPPORTED_OPTION");
  }
  return parsed.data;
};
type PlannedCall = { ids: string[]; options: GeoRouteOptions; optimize: boolean };
export const createGeoRouteService = (
  dependencies: GeoRouteChainDependencies & {
    configured: (context: GeoContext) => Promise<GeoConfig>;
    adapter: GeoapifyAdapter;
  },
) => {
  const prepare = async (stops: readonly GeoRouteStop[], context: GeoContext) => {
    const addresses = new Map<string, z.infer<typeof GeoGeocodeDataSchema>>();
    const missing = new Map<string, GeoGeocodeInput>();
    for (const stop of stops) {
      if (!stop.address) continue;
      const key = geoCacheKey("geocode", stop.address, context.locale ?? "en");
      if (addresses.has(key) || missing.has(key)) continue;
      const hit = await dependencies.cache.get(key, GeoGeocodeDataSchema);
      if (hit) addresses.set(key, hit);
      else missing.set(key, stop.address);
    }
    const known = stops.map((stop) =>
      stop.point
        ? { id: stop.id, label: stop.label, point: stop.point }
        : (() => {
            const found = addresses.get(geoCacheKey("geocode", stop.address, context.locale ?? "en"));
            return found ? { id: stop.id, label: stop.label, point: found.address.point, address: found.address } : undefined;
          })(),
    );
    return {
      cost: missing.size * 1000,
      known,
      async resolve(call: RouteCall, config: GeoConfig): Promise<GeoRouteResolvedStop[]> {
        const result: GeoRouteResolvedStop[] = [];
        for (const stop of stops) {
          if (stop.point) {
            result.push({ id: stop.id, label: stop.label, point: stop.point });
            continue;
          }
          const key = geoCacheKey("geocode", stop.address, context.locale ?? "en");
          let found = addresses.get(key);
          if (!found) {
            found = await call("geocode", stop.address, GeoGeocodeDataSchema, async (signal) => {
              const data = await dependencies.adapter.geocode(stop.address!, config.apiKey, context.locale ?? "en", signal);
              if (!data.candidates.length) throw new GeoError("GEO_ADDRESS_NOT_FOUND", { stopId: stop.id });
              if (data.candidates.length > 1) throw new GeoError("GEO_ADDRESS_AMBIGUOUS", { stopId: stop.id, candidates: data.candidates });
              return { address: data.candidates[0]!, provenance: data.provenance };
            });
            addresses.set(key, found);
          }
          result.push({ id: stop.id, label: stop.label, point: found.address.point, address: found.address });
        }
        return result;
      },
    };
  };
  const pricing = (step: PlannedCall, allowance: number): GeoRouteCallPricing => ({
    pairs: step.ids.length - 1,
    avoids: step.options.avoid?.length ?? 0,
    optimize: step.optimize,
    distanceAllowanceMeters: allowance,
  });
  const preflight = (
    stops: readonly (GeoRouteResolvedStop | undefined)[],
    options: GeoRouteOptions,
    allowance: number,
    optimize = false,
  ) => {
    if (optimize) {
      // Every route connects all known stops. Their minimum spanning tree is an order-independent lower bound.
      const known = stops.filter((stop): stop is GeoRouteResolvedStop => !!stop);
      const connected = new Set<number>([0]);
      let lowerBound = 0;
      while (connected.size < known.length) {
        let shortest = Infinity,
          next = -1;
        for (const from of connected)
          for (let to = 0; to < known.length; to++)
            if (!connected.has(to)) {
              const distance = geoDistance(known[from]!.point, known[to]!.point);
              if (distance < shortest) {
                shortest = distance;
                next = to;
              }
            }
        connected.add(next);
        lowerBound += shortest;
      }
      const pairs = stops.length - 1;
      if (lowerBound > pairs * allowance) limitExceeded("distanceAllowanceMeters", pairs * allowance, lowerBound);
      if (options.mode === "walk" && lowerBound > pairs * 100_000) limitExceeded("walk.legMeters", pairs * 100_000, lowerBound);
      return;
    }
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1],
        b = stops[i];
      if (!a || !b) continue;
      const distance = geoDistance(a.point, b.point);
      if (distance > allowance) limitExceeded("distanceAllowanceMeters", allowance, distance);
      walkDistance([a, b], options);
    }
  };
  const execute = async (
    step: PlannedCall,
    stops: readonly GeoRouteResolvedStop[],
    allowance: number,
    call: RouteCall,
    config: GeoConfig,
    context: GeoContext,
  ) => {
    const selected = step.ids.map((id) => stops.find((stop) => stop.id === id)!);
    preflight(selected, step.options, allowance, step.optimize);
    return call(
      "route",
      { stops: selected, options: step.options, optimize: step.optimize },
      providerData,
      (signal) => dependencies.adapter.route(selected, step.options, step.optimize, config.apiKey, context.locale ?? "en", signal),
      pricing(step, allowance),
      (data) => data.distanceMeters,
    );
  };
  const calculate = async (input: GeoRouteCalculateInput, context: GeoContext) => {
    const config = await dependencies.configured(context);
    const { plan } = parse(GeoRouteCalculateInputSchema, input);
    const { defaults, byDeparture } = validateRoutePlan(plan);
    const allowance = plan.distanceAllowanceMeters ?? 500_000;
    const key = geoCacheKey(
      "route",
      {
        calculate: {
          stops: plan.stops.map((stop) => (stop.address ? { ...stop, address: normalizeGeoInput(stop.address, "geocode") } : stop)),
          options: defaults,
          distanceAllowanceMeters: allowance,
          optimize: plan.optimize ?? false,
          legOptions: plan.stops.flatMap((stop) => {
            const options = byDeparture.get(stop.id);
            return options && !sameRouteOptions(options, defaults) ? [{ fromStopId: stop.id, options }] : [];
          }),
        },
      },
      context.locale ?? "en",
    );
    const cached = await dependencies.cache.get(key, GeoRouteCalculateDataSchema);
    if (cached) return cached;
    const prepared = await prepare(plan.stops, context);
    const steps: PlannedCall[] = [];
    if (plan.optimize) {
      steps.push({ ids: plan.stops.map((stop) => stop.id), options: defaults, optimize: true });
      for (const [id, options] of byDeparture)
        if (!sameRouteOptions(options, defaults)) {
          const i = plan.stops.findIndex((stop) => stop.id === id);
          steps.push({ ids: [id, plan.stops[i + 1]!.id], options, optimize: false });
        }
    } else {
      for (let i = 0; i < plan.stops.length - 1; i++) {
        const options = byDeparture.get(plan.stops[i]!.id) ?? defaults;
        const last = steps.at(-1);
        if (last && sameRouteOptions(last.options, options)) last.ids.push(plan.stops[i + 1]!.id);
        else steps.push({ ids: [plan.stops[i]!.id, plan.stops[i + 1]!.id], options, optimize: false });
      }
    }
    for (const step of plan.optimize ? steps.slice(0, 1) : steps)
      preflight(
        step.ids.map((id) => prepared.known[plan.stops.findIndex((stop) => stop.id === id)]),
        step.options,
        allowance,
        step.optimize,
      );
    const result = await runGeoRouteChain(
      dependencies,
      context,
      config,
      prepared.cost + steps.reduce((sum, step) => sum + reserveRouteCall(pricing(step, allowance)), 0),
      async (call) => {
        let stops = await prepared.resolve(call, config);
        let legs: GeoRouteLeg[] = [];
        const first = steps[0]!;
        if (plan.optimize) {
          const optimized = await execute(first, stops, allowance, call, config, context);
          stops = optimized.stops;
          legs = optimized.legs;
          for (let i = 0; i < legs.length; i++) {
            const options = byDeparture.get(stops[i]!.id);
            if (options && !sameRouteOptions(options, defaults)) {
              const step = { ids: [stops[i]!.id, stops[i + 1]!.id], options, optimize: false };
              legs[i] = (await execute(step, stops, allowance, call, config, context)).legs[0]!;
            }
          }
        } else {
          // Validate the complete resolved route before the first routing call.
          for (const step of steps)
            preflight(
              step.ids.map((id) => stops.find((stop) => stop.id === id)!),
              step.options,
              allowance,
            );
          for (const step of steps) legs.push(...(await execute(step, stops, allowance, call, config, context)).legs);
        }
        return { route: assembleRoute(stops, defaults, legs, dependencies.now(), allowance) };
      },
    );
    await dependencies.cache.put(key, "route", result, false);
    return result;
  };
  const update = async (input: GeoRouteUpdateInput, context: GeoContext): Promise<GeoRouteUpdateData> => {
    const config = await dependencies.configured(context);
    const { route, changes, distanceAllowanceMeters } = parse(GeoRouteUpdateInputSchema, input);
    validateSavedRoute(route);
    const allowance = distanceAllowanceMeters ?? route.distanceAllowanceMeters;
    const key = geoCacheKey("route", { update: input }, context.locale ?? "en");
    const cached = await dependencies.cache.get(key, GeoRouteUpdateDataSchema);
    if (cached) return cached;
    let defaults = routeOptions(route.options),
      stops = [...route.stops];
    const byDeparture = new Map(route.legs.map((leg) => [leg.fromStopId, routeOptions(leg.options)]));
    const steps: PlannedCall[] = [];
    let insertion: GeoRouteUpdateData["insertion"];
    let inserted: Awaited<ReturnType<typeof prepare>> | undefined;
    let fixedGap: number | undefined;
    if (changes.type === "insert") {
      validateRouteStops([...route.stops.map((stop) => ({ id: stop.id, label: stop.label, point: stop.point })), changes.stop]);
      if (changes.afterStopId !== undefined) {
        fixedGap = stops.findIndex((stop) => stop.id === changes.afterStopId);
        if (fixedGap < 0 || fixedGap >= stops.length - 1) throw new GeoError("GEO_UNSUPPORTED_OPTION");
      }
      inserted = await prepare([changes.stop], context);
      // Reserve the most expensive possible three gaps before resolving an address.
      const candidateIndexes = fixedGap !== undefined ? [fixedGap] : stops.slice(0, -1).map((_, i) => i);
      for (const index of candidateIndexes)
        steps.push({
          ids: [stops[index]!.id, changes.stop.id, stops[index + 1]!.id],
          options: route.legs[index]!.options,
          optimize: false,
        });
      steps.sort((a, b) => reserveRouteCall(pricing(b, allowance)) - reserveRouteCall(pricing(a, allowance)));
      steps.splice(3);
      const point = inserted.known[0];
      if (point)
        for (const index of fixedGap !== undefined ? [fixedGap] : insertionGaps(route, point.point))
          preflight([stops[index], point, stops[index + 1]], route.legs[index]!.options, allowance);
    } else if (changes.type === "move") {
      const index = stops.findIndex((stop) => stop.id === changes.stopId);
      if (index < 0 || changes.toIndex >= stops.length) throw new GeoError("GEO_UNSUPPORTED_OPTION");
      const [stop] = stops.splice(index, 1);
      stops.splice(changes.toIndex, 0, stop!);
    } else if (changes.type === "options") {
      if (changes.leg) {
        const index = route.legs.findIndex((leg) => leg.fromStopId === changes.leg!.fromStopId && leg.toStopId === changes.leg!.toStopId);
        if (index < 0) throw new GeoError("GEO_UNSUPPORTED_OPTION");
        byDeparture.set(changes.leg.fromStopId, routeOptions(changes.options, route.legs[index]!.options));
      } else {
        defaults = routeOptions(changes.options, defaults);
        byDeparture.clear();
      }
    } else {
      steps.push({ ids: stops.map((stop) => stop.id), options: defaults, optimize: true });
      for (const leg of route.legs)
        if (!sameRouteOptions(leg.options, defaults))
          steps.push({ ids: [leg.fromStopId, leg.toStopId], options: leg.options, optimize: false });
    }
    if (changes.type !== "insert" && changes.type !== "optimize") {
      for (let i = 0; i < stops.length - 1; i++) {
        const from = stops[i]!,
          to = stops[i + 1]!,
          options = byDeparture.get(from.id) ?? defaults;
        const reusable = route.legs.find(
          (leg) => leg.fromStopId === from.id && leg.toStopId === to.id && sameRouteOptions(leg.options, options),
        );
        if (!reusable) {
          const last = steps.at(-1);
          if (last && last.ids.at(-1) === from.id && sameRouteOptions(last.options, options)) last.ids.push(to.id);
          else steps.push({ ids: [from.id, to.id], options, optimize: false });
        }
      }
    }
    if (changes.type !== "insert")
      for (const step of changes.type === "optimize" ? steps.slice(0, 1) : steps)
        preflight(
          step.ids.map((id) => stops.find((stop) => stop.id === id)!),
          step.options,
          allowance,
          step.optimize,
        );
    const work = async (call: RouteCall) => {
      let legs: GeoRouteLeg[];
      if (changes.type === "insert") {
        const [point] = await inserted!.resolve(call, config);
        const gaps = fixedGap !== undefined ? [fixedGap] : insertionGaps(route, point!.point);
        // Resolve and validate every candidate before the first paid route request.
        for (const index of gaps) preflight([stops[index], point, stops[index + 1]], route.legs[index]!.options, allowance);
        let winner: { index: number; legs: GeoRouteLeg[]; detour: number; meters: number } | undefined;
        for (const index of gaps) {
          let result: z.infer<typeof providerData>;
          try {
            result = await execute(
              { ids: [stops[index]!.id, point!.id, stops[index + 1]!.id], options: route.legs[index]!.options, optimize: false },
              [...stops, point!],
              allowance,
              call,
              config,
              context,
            );
          } catch (error) {
            if (error instanceof GeoError && error.code === "GEO_NO_ROUTE") continue;
            throw error;
          }
          const detour = result.legs.reduce((sum, leg) => sum + leg.durationSeconds, 0) - route.legs[index]!.durationSeconds;
          const meters = result.distanceMeters - route.legs[index]!.distanceMeters;
          if (!winner || detour < winner.detour || (detour === winner.detour && meters < winner.meters))
            winner = { index, legs: result.legs, detour, meters };
        }
        if (!winner) throw new GeoError("GEO_NO_ROUTE");
        legs = [...route.legs];
        legs.splice(winner.index, 1, ...winner.legs);
        insertion = {
          afterStopId: stops[winner!.index]!.id,
          candidateGaps: gaps.length,
          exhaustive: fixedGap !== undefined || route.legs.length <= 3,
        };
        stops.splice(winner!.index + 1, 0, point!);
      } else if (changes.type === "optimize") {
        const result = await execute(steps[0]!, stops, allowance, call, config, context);
        stops = result.stops;
        legs = result.legs;
        for (let i = 0; i < legs.length; i++) {
          const options = byDeparture.get(stops[i]!.id) ?? defaults;
          if (!sameRouteOptions(options, defaults))
            legs[i] = (
              await execute({ ids: [stops[i]!.id, stops[i + 1]!.id], options, optimize: false }, stops, allowance, call, config, context)
            ).legs[0]!;
        }
      } else {
        const replacements = new Map<string, GeoRouteLeg>();
        for (const step of steps)
          for (const leg of (await execute(step, stops, allowance, call, config, context)).legs) replacements.set(leg.fromStopId, leg);
        legs = stops
          .slice(0, -1)
          .map(
            (stop, i) =>
              replacements.get(stop.id) ?? route.legs.find((leg) => leg.fromStopId === stop.id && leg.toStopId === stops[i + 1]!.id)!,
          );
      }
      const next = assembleRoute(stops, defaults, legs, dependencies.now(), allowance);
      const before = routeSummary(route),
        after = routeSummary(next);
      return GeoRouteUpdateDataSchema.parse({
        route: next,
        before,
        after,
        delta: {
          distanceMeters: after.distanceMeters - before.distanceMeters,
          durationSeconds: after.durationSeconds - before.durationSeconds,
        },
        ...(insertion ? { insertion } : {}),
      });
    };
    const cost = (inserted?.cost ?? 0) + steps.reduce((sum, step) => sum + reserveRouteCall(pricing(step, allowance)), 0);
    const result = cost
      ? await runGeoRouteChain(dependencies, context, config, cost, work)
      : await work(async () => {
          throw new GeoError("GEO_PROVIDER_FAILED");
        });
    await dependencies.cache.put(key, "route", result, false);
    return result;
  };
  return { calculateRoute: calculate, updateRoute: update };
};
