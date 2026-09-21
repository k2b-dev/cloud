import type { ProxyStats } from "./proxy";
import { createProxyStats } from "./proxy";
import type { RouteTable } from "./trie";
import { buildRouteTable } from "./trie";

// ─── Shared mutable state (read by admin page, written by proxy) ─────────────

let currentTable: RouteTable = buildRouteTable([]);
let stats: ProxyStats = createProxyStats();

export const getRouteTable = (): RouteTable => currentTable;
export const setRouteTable = (table: RouteTable): void => {
  currentTable = table;
};

export const getGatewayStats = (): ProxyStats => stats;
export const resetStats = (): void => {
  stats = createProxyStats();
};

export { stats };
