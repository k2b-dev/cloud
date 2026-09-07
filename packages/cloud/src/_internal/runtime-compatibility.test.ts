import { describe, expect, test } from "bun:test";
import type { AppRegistryEntry } from "../contracts/registry";
import { assessRuntimeCompatibility } from "./runtime-compatibility";

const app = (id: string, syncVersion?: string): AppRegistryEntry => ({
  id,
  name: id,
  icon: "box",
  description: id,
  baseUrl: `http://${id}:3000`,
  routes: [`/${id}`],
  runtime: syncVersion ? { release: "sha-0123456789ab", syncVersion } : undefined,
});

describe("assessRuntimeCompatibility", () => {
  test("rejects a Redis (5.x) and NATS (6.x) runtime mix", () => {
    expect(assessRuntimeCompatibility([app("old", "5.9.1"), app("new", "6.2.0")])).toEqual([
      expect.objectContaining({ code: "mixed-sync-generation", severity: "error", appIds: ["old", "new"] }),
    ]);
  });

  test("warns about safe version drift", () => {
    expect(assessRuntimeCompatibility([app("a", "6.1.0"), app("b", "6.2.0")])).toEqual([
      expect.objectContaining({ code: "mixed-sync-version", severity: "warn" }),
    ]);
  });

  test("accepts matching and missing metadata", () => {
    expect(assessRuntimeCompatibility([app("a", "6.2.0"), app("b", "6.2.0"), app("old")])).toEqual([]);
  });

  test("reports malformed versions without treating them as incompatible", () => {
    expect(assessRuntimeCompatibility([app("bad", "next")])).toEqual([
      expect.objectContaining({ code: "invalid-sync-version", severity: "warn", appIds: ["bad"] }),
    ]);
  });
});
