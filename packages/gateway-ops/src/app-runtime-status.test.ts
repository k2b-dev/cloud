import { describe, expect, test } from "bun:test";
import type { AppRegistryEntry } from "@k2b/cloud/contracts";
import { buildAppRuntimeStatuses } from "./app-runtime-status";

const app = (id: string, syncVersion: string): AppRegistryEntry => ({
  id,
  name: id,
  icon: "box",
  description: id,
  baseUrl: `http://${id}`,
  routes: [`/${id}`],
  runtime: { release: "sha-0123456789ab", syncVersion },
});

describe("buildAppRuntimeStatuses", () => {
  test("attaches compatibility reasons to every affected app", () => {
    const statuses = buildAppRuntimeStatuses([app("old", "5.9.1"), app("new", "6.3.2")], []);
    expect(statuses.get("old")?.status).toBe("error");
    expect(statuses.get("new")?.status).toBe("error");
    expect(statuses.get("new")?.signals[0]).toContain("registrations or durable work");
  });

  test("keeps rejected unknown apps visible", () => {
    const statuses = buildAppRuntimeStatuses([], [{ key: "apps/broken", version: "1", reason: "routes must be an array" }]);
    expect(statuses.get("broken")).toEqual({ status: "error", signals: ["Registry entry rejected: routes must be an array"] });
  });
});
