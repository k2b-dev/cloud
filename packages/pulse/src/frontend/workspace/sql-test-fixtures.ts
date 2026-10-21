import type { SavedQuery, SqlLimits, SqlResult } from "./sql-client";

export const SQL_TEST_NOW = Date.parse("2026-10-20T14:32:00Z");
export const SQL_TEST_RUN_ID = "00000000-0000-4000-8000-000000000001";
export const sqlTestLimits: SqlLimits = {
  profile: "normal",
  memoryBytes: 2_000_000_000,
  timeSeconds: 10,
  maxRows: 10_000,
  maxResultBytes: 4 * 1024 ** 2,
  queriesUsed: 12,
  queriesPerHour: 600,
  resetAt: "2026-10-20T15:00:00Z",
  baseSlots: 1,
  cloudSlots: 3,
  maxWaiting: 20,
  waitMs: 5000,
};
export const sqlTestResult: SqlResult = {
  runId: SQL_TEST_RUN_ID,
  columns: [{ name: "value", type: "UInt64" }],
  rows: [[1]],
  rowCount: 1,
  truncated: false,
  stats: { elapsedMs: 38, readRows: 1, readBytes: 100 },
  limits: sqlTestLimits,
};
export const sqlTestQuery: SavedQuery = {
  id: "Qry001",
  baseId: "Base01",
  name: "CPU",
  sql: "SELECT :host",
  params: { host: "web-01" },
  pinned: false,
  revision: 2,
  createdBy: null,
  updatedBy: null,
  createdAt: "2026-10-20T14:00:00Z",
  updatedAt: "2026-10-20T14:00:00Z",
};
