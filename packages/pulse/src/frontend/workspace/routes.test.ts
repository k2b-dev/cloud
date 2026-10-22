import { expect, test } from "bun:test";
import { buildPulseWorkspaceHref, readWorkspacePathState } from "./routes";

test("base pages default to overview and source URLs restore selection", () => {
  expect(readWorkspacePathState("/app/pulse/Base01", "Base01")).toEqual({ view: "overview", sourceId: "" });
  expect(readWorkspacePathState("/app/pulse/Base01/sources/Src001", "Base01")).toEqual({ view: "sources", sourceId: "Src001" });
  expect(readWorkspacePathState("/app/pulse/Base012/dashboards", "Base01").view).toBe("overview");
});

test("navigation exposes sources and dashboards", () => {
  expect(buildPulseWorkspaceHref({ baseId: "Base01", state: { view: "dashboards" } })).toBe("/app/pulse/Base01/dashboards");
  expect(buildPulseWorkspaceHref({ baseId: "Base01", state: { view: "sources" } })).toBe("/app/pulse/Base01/sources");
  expect(buildPulseWorkspaceHref({ baseId: "Base01", state: { view: "sources", sourceId: "Src001" } })).toBe(
    "/app/pulse/Base01/sources/Src001",
  );
  expect(buildPulseWorkspaceHref({ baseId: "", state: { view: "sources" } })).toBe("/app/pulse");
});

test("SQL routes restore unsaved SQL/values and saved UUID or short IDs", () => {
  const state = { view: "sql" as const, sql: "SELECT :host WHERE x = 'ä & ?'", params: { host: "db/01" } };
  const href = buildPulseWorkspaceHref({ baseId: "Base01", state });
  expect(readWorkspacePathState(href, "Base01")).toEqual({ ...state, sourceId: "", queryId: "" });
  for (const queryId of ["Qry001", "00000000-0000-4000-8000-000000000001"]) {
    const href = buildPulseWorkspaceHref({ baseId: "Base01", state: { ...state, queryId } });
    expect(href).toContain("sql=");
    expect(readWorkspacePathState(href, "Base01")).toEqual({ view: "sql", sourceId: "", sql: state.sql, queryId, params: state.params });
  }
  expect(readWorkspacePathState("/app/pulse/Base01/sql", "Base01")).toEqual({
    view: "sql",
    sourceId: "",
    queryId: "",
    sql: "",
    params: {},
  });
});

test("URL payload bounds omit whole drafts, keep saved identity/settings, and reject malformed values", () => {
  for (const queryId of ["", "Qry001"]) {
    const href = buildPulseWorkspaceHref({
      baseId: "Base01",
      state: {
        view: "sql",
        queryId,
        sql: "SELECT '" + "ä".repeat(4000) + "'",
        params: { a: "x".repeat(2048), b: "x".repeat(2048) },
        settings: "usage",
      },
    });
    expect(href).toBe(`/app/pulse/Base01/sql${queryId ? `/${queryId}` : ""}?settings=usage`);
    expect(href.length).toBeLessThanOrEqual(4000);
  }
  for (const raw of ["{", "[]", "null", '{"base_tz":"UTC"}', '{"a":12}', '{"__proto__":"x"}']) {
    const state = readWorkspacePathState(`/app/pulse/Base01/sql?params=${encodeURIComponent(raw)}`, "Base01");
    // __proto__ is a valid SQL parameter name and remains an own data property, never a prototype write.
    expect(state.params).toEqual(raw.includes("__proto__") ? JSON.parse(raw) : {});
  }
  expect(readWorkspacePathState("/app/pulse/Base01/sql?sql=" + "a".repeat(4000), "Base01").sql).toBe("");
  expect(readWorkspacePathState("/app/pulse/Base01/sql/%ZZ", "Base01").queryId).toBe("");
  expect(readWorkspacePathState("/app/pulse/Base01/sql/Qry001?sql=SELECT+2", "Base01").sql).toBe("SELECT 2");
});

test("settings tabs preserve underlying source/SQL URL state", () => {
  for (const settings of ["general", "members", "retention", "usage", "danger"] as const) {
    const href = buildPulseWorkspaceHref({
      baseId: "Base01",
      state: { view: "sql", queryId: "Qry001", params: { host: "web-01" }, settings },
    });
    expect(readWorkspacePathState(href, "Base01")).toMatchObject({ view: "sql", queryId: "Qry001", params: { host: "web-01" }, settings });
  }
  expect(readWorkspacePathState("/app/pulse/Base01/sources/Src001?settings=general", "Base01")).toEqual({
    view: "sources",
    sourceId: "Src001",
    settings: "general",
  });
  expect(readWorkspacePathState("/app/pulse/Base01/sources?settings=bogus", "Base01")).not.toHaveProperty("settings");
});

test("overview and authorized alert references survive settings, reload and oversized SQL", () => {
  expect(buildPulseWorkspaceHref({ baseId: "Base01", state: { view: "overview" } })).toBe("/app/pulse/Base01");
  const href = buildPulseWorkspaceHref({
    baseId: "Base01",
    state: { view: "sql", alertId: "Alt001", sql: "SELECT '" + "ä".repeat(5000) + "'", params: { host: "web-01" }, settings: "general" },
  });
  expect(href).toBe("/app/pulse/Base01/sql?settings=general&alert=Alt001");
  expect(readWorkspacePathState(href, "Base01")).toMatchObject({ view: "sql", alertId: "Alt001", settings: "general" });
  expect(readWorkspacePathState("/app/pulse/Base01/sql/Qry001?alert=Alt001", "Base01")).not.toHaveProperty("alertId");
  expect(readWorkspacePathState("/app/pulse/Base01/sql?alert=%2Fbad", "Base01")).not.toHaveProperty("alertId");
});

test("dashboard selection and range survive URLs", () => {
  const state = {
    view: "dashboards" as const,
    dashboardId: "Dash01",
    dashboardRange: { range: "7d" as const, from: "2026-10-01T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z" },
  };
  const href = buildPulseWorkspaceHref({ baseId: "Base01", state });
  expect(readWorkspacePathState(href, "Base01")).toEqual({ ...state, sourceId: "" });
  expect(readWorkspacePathState("/app/pulse/Base01/dashboards", "Base01")).toEqual({
    view: "dashboards",
    sourceId: "",
    dashboardId: "",
    dashboardRange: { range: "24h" },
  });
  expect(readWorkspacePathState("/app/pulse/Base01/dashboards/Dash01?range=90d&from=bad&to=no", "Base01").dashboardRange).toEqual({
    range: "90d",
  });
});
