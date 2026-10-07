import { expect, test } from "bun:test";
import { backgroundCodeRouteAllowed, backgroundDatabaseOperation } from "./background-code-policy";

test("background code admits computation and artifacts but no route around task grants", () => {
  for (const path of [
    "/runtime/compile",
    "/runtime/action",
    "/runtime/capabilities",
    "/runtime/ai",
    "/runtime/pdf",
    "/presentations",
    "/runtime/http",
    "/aBc234/database",
    "/aBc234/database/maintenance/connect",
    "/aBc234/storage",
  ])
    expect(backgroundCodeRouteAllowed(path, "POST")).toBe(true);
  for (const path of [
    "/runtime/secrets",
    "/runtime/storage",
    "/runtime/database",
    "/runtime/capabilities/resolve",
    "/runtime/capabilities/streams/read",
    "/runtime/rename",
    "/apps",
    "/runtime/../http",
  ])
    expect(backgroundCodeRouteAllowed(path, "POST")).toBe(false);
  expect(backgroundCodeRouteAllowed("/runtime/host.js", "GET")).toBe(true);
  expect(backgroundCodeRouteAllowed("/aBc234/compiled", "GET")).toBe(true);
  expect(backgroundCodeRouteAllowed("/aBc234/compiled", "DELETE")).toBe(false);
  expect(backgroundCodeRouteAllowed("/aBc234/secret", "GET")).toBe(false);
});

test("background scripts can load only the four named lazy runtime libraries", () => {
  for (const name of ["csv", "sheet", "finance", "pdf-read"])
    expect(backgroundCodeRouteAllowed(`/runtime/chunks/${name}`, "GET")).toBe(true);
  for (const path of ["/runtime/chunks/private", "/runtime/chunks/../secret", "/runtime/chunks/sheet/extra"])
    expect(backgroundCodeRouteAllowed(path, "GET")).toBe(false);
  expect(backgroundCodeRouteAllowed("/runtime/chunks/sheet", "POST")).toBe(false);
});

test("flat database operations retain the stored grant vocabulary", () => {
  for (const operation of ["list", "get", "insert", "update", "delete"] as const)
    expect(backgroundDatabaseOperation(operation)).toBe(`rows.${operation}`);
  expect(backgroundDatabaseOperation("query")).toBe("query");
  expect(backgroundCodeRouteAllowed("/runtime/chunks/csv", "GET")).toBe(true);
});

test("a table-scoped mandate allows only the mapped insert on that table", async () => {
  const { mandatePolicyAllows, parseMandatePolicy } = await import("@k2b/cloud/services/mandates");
  const policy = parseMandatePolicy({
    version: 1,
    apps: ["assistant"],
    operations: ["runtime.database"],
    actions: "preapproved",
    grants: [{ kind: "database", fixedInput: { resourceId: "AbC234", operation: "rows.insert", table: "invoices" } }],
  });
  const allows = (table: string) =>
    mandatePolicyAllows(policy, {
      appId: "assistant",
      operation: "runtime.database",
      actionApproval: "none",
      input: { resourceId: "AbC234", operation: backgroundDatabaseOperation("insert"), table },
    });
  expect(allows("invoices")).toBe(true);
  expect(allows("other")).toBe(false);
});
