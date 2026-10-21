import type { GeoFunction } from "../../contracts/geo";
export type GeoCostStep = { fn: GeoFunction; limit?: number };
/** Integer millicredits. Use requested limits, including for empty and short responses. */
export const geoReferenceCost = ({ fn, limit = 20 }: GeoCostStep): number => (fn === "places" ? Math.ceil(limit / 20) : 1) * 1000;
export const geoReserveCost = (chain: readonly GeoCostStep[]): number => chain.reduce((sum, step) => sum + geoReferenceCost(step), 0);
