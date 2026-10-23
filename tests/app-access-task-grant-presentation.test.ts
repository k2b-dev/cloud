import { expect, spyOn, test } from "bun:test";
import * as registry from "../packages/cloud/src/_internal/registry";
import { recentTestApp, recentTestAuthority, recentTestRegistryApp } from "../packages/cloud/src/ai/recent-resources.test-fixture";
import type { AppRegistryEntry } from "../packages/cloud/src/contracts/registry";
import { taskGrantReview } from "../packages/core/src/task-grant-presentation";

test("task grant review presents an allowed declared app and falls back after revocation or scope denial", async () => {
  const app: AppRegistryEntry = { ...recentTestRegistryApp, access: { kind: "signedIn" } };
  const lookups = [
    spyOn(registry, "getApp").mockImplementation(async () => app),
    spyOn(registry, "getCapability").mockResolvedValue(recentTestApp),
  ];
  const grants = [{ appId: "demo", capabilityId: "item.read", kind: "query" as const, fixedInput: {} }];
  try {
    expect((await taskGrantReview(grants, "en", recentTestAuthority)).value).toContain("**Read item** · Demo");
    app.access = { kind: "roles", roles: ["admin"] };
    expect((await taskGrantReview(grants, "en", recentTestAuthority)).value).toContain("**item\\.read** · demo");
    app.access = { kind: "signedIn" };
    expect((await taskGrantReview(grants, "en", { ...recentTestAuthority, scopes: ["core:read"] })).value).toContain(
      "**item\\.read** · demo",
    );
    expect((await taskGrantReview(grants, "en")).value).toContain("**item\\.read** · demo");
  } finally {
    for (const lookup of lookups) lookup.mockRestore();
  }
});
