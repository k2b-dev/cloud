import { expect, test } from "bun:test";
import { backgroundCodeRouteAllowed } from "./background-code-policy";

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
