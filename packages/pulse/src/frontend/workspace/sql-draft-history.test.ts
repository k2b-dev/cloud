import { expect, test } from "bun:test";
import { buildPulseWorkspaceHref, type WorkspaceRouteState } from "./routes";
import { readSqlDraftHistory, sqlDraftHistoryState } from "./sql-draft-history";

const route: WorkspaceRouteState = {
  view: "sql",
  sourceId: "",
  sql: `SELECT '${"ä".repeat(4000)}', :host`,
  params: { host: "db\\01\nsecret input" },
};
const href = buildPulseWorkspaceHref({ baseId: "Base01", state: route });

test("long drafts restore from their history entry including reader-only unsaved SQL and values", () => {
  expect(href).toBe("/app/pulse/Base01/sql");
  const state = sqlDraftHistoryState({ hostNavigation: 2 }, "Base01", route);
  expect(state.hostNavigation).toBe(2);
  expect(readSqlDraftHistory(structuredClone(state), "Base01", href)).toEqual(route);
  expect(readSqlDraftHistory(state, "Base01", href + "?settings=members")).toEqual(route);
  expect(readSqlDraftHistory(state, "Base02", "/app/pulse/Base02/sql")).toBeNull();
  expect(readSqlDraftHistory(state, "Base01", href + "/Qry001")).toBeNull();
  expect(readSqlDraftHistory(null, "Base01", href)).toBeNull();
  const smaller = sqlDraftHistoryState(state, "Base01", { ...route, sql: "SELECT 1", params: {} });
  expect(smaller).toEqual({ hostNavigation: 2 });
});

test("history drafts enforce the console's byte and parameter bounds without affecting host state", () => {
  for (const invalid of [
    { ...route, sql: "x".repeat(16 * 1024 + 1) },
    { ...route, params: { host: "x".repeat(2049) } },
    { ...route, params: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`p${index}`, "1"])) },
  ])
    expect(sqlDraftHistoryState({ host: true }, "Base01", invalid)).toEqual({ host: true });
  expect(
    readSqlDraftHistory({ pulseSqlDraft: { baseId: "Base01", href, sql: route.sql, params: { host: 1 } } }, "Base01", href),
  ).toBeNull();
});
