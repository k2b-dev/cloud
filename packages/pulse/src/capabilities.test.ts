import { expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { UniversalSearchDataSchema, UniversalSearchInputSchema } from "@k2b/cloud/contracts";
import { pulseCapabilities } from "./capabilities";
import { BaseListDataSchema, BaseReadInputSchema, SourceReadInputSchema } from "./capability-contracts";
import { fixturePolicy } from "./store/base-store.test-fixture";

test("declares only base and source readers", () => {
  expect(Object.keys(pulseCapabilities.types).sort()).toEqual(["base", "source"]);
  expect(Object.keys(pulseCapabilities.queries).sort()).toEqual(["base.list", "base.read", "base.search", "source.list", "source.read"]);
  expect(pulseCapabilities.types.base.reader).toBe("base.read");
  expect(pulseCapabilities.types.source.reader).toBe("source.read");
  expect(pulseCapabilities.protocolVersion).toBe(2);
  expect("actions" in pulseCapabilities).toBe(false);
  expect(pulseCapabilities.queries["base.search"].input).toBe(UniversalSearchInputSchema);
  expect(pulseCapabilities.queries["base.search"].data).toBe(UniversalSearchDataSchema);
  expect(BaseReadInputSchema.safeParse({ id: "00000000-0000-4000-8000-000000000001" }).success).toBe(false);
  expect(SourceReadInputSchema.safeParse({ id: "00000000-0000-4000-8000-000000000001" }).success).toBe(false);
  expect(() => compileCapabilityManifest("pulse", pulseCapabilities)).not.toThrow();
});

test("preserves the base result contract", () => {
  expect(
    BaseListDataSchema.safeParse([
      {
        store: {
          state: "active",
          operation: null,
          errorCode: null,
          errorAt: null,
          writeBlockReason: null,
          profile: "normal",
          limits: fixturePolicy.defaultLimits,
          usage: null,
        },
        id: "Base01",
        ref: { type: "pulse.base", id: "Base01" },
        name: "Telemetry",
        description: null,
        createdAt: "2026-08-04T00:00:00.000Z",
        updatedAt: "2026-08-04T00:00:00.000Z",
        links: [{ rel: "open", href: "/app/pulse/base" }],
      },
    ]).success,
  ).toBeTrue();
});
