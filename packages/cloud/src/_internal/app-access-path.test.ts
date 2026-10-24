import { expect, test } from "bun:test";
import { appAccessManagementPath } from "./app-access-path";

test("management stays on the first gateway prefix and encodes the app ID", () => {
  expect(appAccessManagementPath({ id: "demo id", routes: ["/api/demo/", "/app/demo"] })).toBe("/api/demo/_cloud/access/demo%20id");
  expect(appAccessManagementPath({ id: "demo", routes: ["/"] })).toBe("/_cloud/access/demo");
});

test("management rejects missing, external, ambiguous and normalized-away prefixes", () => {
  for (const routes of [
    [],
    ...[
      "//evil.test",
      "https://evil.test",
      "/\\evil",
      "/demo?next=x",
      "/demo#x",
      "/demo/*",
      "/demo/:id",
      "/demo/../",
      "/%2e%2e/",
      "/demo/%2Fother",
      "/demo/%5cother",
      "/demo x",
    ].map((prefix) => [prefix]),
  ]) {
    expect(() => appAccessManagementPath({ id: "demo", routes })).toThrow("routed path prefix");
  }
});
