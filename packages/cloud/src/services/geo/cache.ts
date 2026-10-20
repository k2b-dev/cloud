import { createHash } from "node:crypto";
import type { z } from "zod";
import type { GeoFunction } from "../../contracts/geo";
import { requestCacheRedis } from "../request-cache-redis";
import type { GeoRedis } from "./bucket";

export const GEO_ADAPTER_VERSION = "geoapify-v1";
export const GEO_MAX_JSON_BYTES = 256 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const normalizeGeoInput = (input: unknown, fn: GeoFunction, path = ""): unknown => {
  if (typeof input === "string") return path === "polyline6" ? hash(input) : input.toLowerCase().trim().replace(/\s+/g, " ");
  if (typeof input === "number") {
    if (["lat", "lon", "west", "south", "east", "north"].includes(path)) return Number(input.toFixed(fn === "autocomplete" ? 2 : 5));
    return input;
  }
  if (Array.isArray(input)) {
    const values = input.map((value) => normalizeGeoInput(value, fn));
    return path === "categories" ? values.sort() : values;
  }
  if (input && typeof input === "object")
    return Object.fromEntries(
      Object.entries(input)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, normalizeGeoInput(value, fn, key)]),
    );
  return input;
};
export const geoCacheKey = (fn: GeoFunction, input: unknown, locale: string) =>
  `geo:cache:v1:${hash(JSON.stringify([GEO_ADAPTER_VERSION, fn, locale, normalizeGeoInput(input, fn)]))}`;
export const createGeoCache = (client: () => Promise<GeoRedis> = requestCacheRedis) => ({
  async get<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
    try {
      const value = await (await client()).send("GET", [key]);
      if (typeof value !== "string" || Buffer.byteLength(value) > GEO_MAX_JSON_BYTES) return null;
      const parsed = schema.safeParse(JSON.parse(value));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
  async put(key: string, fn: GeoFunction, value: unknown, empty: boolean) {
    try {
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json) > GEO_MAX_JSON_BYTES) return;
      const ttl = empty ? 3600 : fn === "autocomplete" ? 7 * 86400 : fn === "places" ? 86400 : 30 * 86400;
      await (await client()).send("SET", [key, json, "EX", String(ttl)]);
    } catch {
      /* Cache failure does not change an admitted response. */
    }
  },
});
