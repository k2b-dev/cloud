import { expect, spyOn, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { UniversalSearchDataSchema, UniversalSearchInputSchema } from "@k2b/cloud/contracts";
import { ok } from "@k2b/stdlib";
import { pulseCapabilities } from "./capabilities";
import { BaseListDataSchema, BaseReadInputSchema, SourceReadInputSchema } from "./capability-contracts";
import { savedQueries } from "./service/saved-queries";
import { adminFixtureIdentity } from "./store/admin-identity.test-fixture";
import { fixturePolicy } from "./store/base-store.test-fixture";

test("declares SQL and saved query capabilities with base and source readers", () => {
  expect(Object.keys(pulseCapabilities.types).sort()).toEqual(["base", "source"]);
  expect(Object.keys(pulseCapabilities.queries).sort()).toEqual([
    "alert.list",
    "alert.read",
    "base.list",
    "base.read",
    "base.search",
    "saved_query.list",
    "source.list",
    "source.read",
    "sql.run",
  ]);
  expect(Object.keys(pulseCapabilities.actions).sort()).toEqual([
    "alert.delete",
    "alert.save",
    "saved_query.delete",
    "saved_query.save",
    "source.create",
    "source.update",
  ]);
  expect(pulseCapabilities.actions["alert.save"].approval).toBe("rememberable");
  expect(pulseCapabilities.actions["alert.save"].idempotency).toBe("required");
  for (const action of [
    pulseCapabilities.actions["alert.delete"],
    pulseCapabilities.actions["source.create"],
    pulseCapabilities.actions["source.update"],
  ])
    expect("approval" in action).toBe(false);
  for (const name of ["source.create", "source.update"] as const) {
    expect(pulseCapabilities.actions[name].openWorld).toBe(true);
    expect(pulseCapabilities.actions[name].idempotency).toBe("required");
  }
  expect(
    pulseCapabilities.actions["source.create"].input.safeParse({
      baseId: "Base01",
      kind: "http_ingest",
      name: "Web",
      bearerToken: "FORBIDDEN",
    }).success,
  ).toBe(false);
  expect(pulseCapabilities.types.base.reader).toBe("base.read");
  expect(pulseCapabilities.types.source.reader).toBe("source.read");
  expect(pulseCapabilities.protocolVersion).toBe(2);
  expect(pulseCapabilities.actions["saved_query.save"].approval).toBe("rememberable");
  expect(pulseCapabilities.actions["saved_query.save"].idempotency).toBe("required");
  expect(pulseCapabilities.actions["saved_query.delete"].destructive).toBe(true);
  expect("approval" in pulseCapabilities.actions["saved_query.delete"]).toBe(false);
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

test("delete capability returns its declared receipt when the service returns no data", async () => {
  const remove = spyOn(savedQueries, "remove").mockResolvedValue(ok());
  const context: CapabilityExecutionContext = {
    ...adminFixtureIdentity(),
    user: null,
    locale: "en",
    requestId: "pulse-delete-receipt-test",
    origin: "http",
    signal: new AbortController().signal,
    idempotencyKey: "delete-receipt-test",
  };
  try {
    const action = pulseCapabilities.actions["saved_query.delete"];
    const result = await action.run({ baseId: "Base01", queryId: "Query1", expectedRevision: 1 }, context);
    expect(result).toEqual({ ok: true, data: { data: { deleted: true } } });
    if (!result.ok) throw new Error("DELETE_FAILED");
    expect(action.data.safeParse(result.data.data).success).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    remove.mockRestore();
  }
});
