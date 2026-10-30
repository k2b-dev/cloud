import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { appStatusDeclaration, appStatusManifest } from "../../../../scripts/fixtures/app-status";
import { readBoundedJson } from "../_internal/bounded-json";
import { compileCapabilities } from "../_internal/capabilities";
import { resolveLiveCapabilityRegistryEntry } from "../_internal/registry";
import { AppStatusDetailDataSchema, AppStatusSummaryDataSchema, AppStatusSummaryInputSchema, appStatusIssues } from "./app-status";
import { CapabilityManifestSchema } from "./capabilities";

describe("app-status contract", () => {
  test("bounds input and preserves absent measurements", () => {
    expect(AppStatusSummaryInputSchema.safeParse({ appIds: [], window: "24h" }).success).toBe(false);
    expect(AppStatusSummaryInputSchema.safeParse({ appIds: Array(201).fill("mail"), window: "24h" }).success).toBe(false);
    expect(AppStatusSummaryInputSchema.safeParse({ appIds: ["mail"], window: "2h" }).success).toBe(false);
    const data = { apps: [{ appId: "mail", traffic: null, links: [] }], otherApps: [] };
    expect(AppStatusSummaryDataSchema.parse(data).apps[0]?.traffic).toBeNull();
    expect(AppStatusSummaryDataSchema.safeParse({ ...data, otherApps: Array(51).fill("mail") }).success).toBe(false);
    expect(
      AppStatusSummaryDataSchema.safeParse({
        ...data,
        apps: [{ ...data.apps[0], links: Array(5).fill({ label: "Open", href: "/admin/logs" }) }],
      }).success,
    ).toBe(false);
    for (const href of ["https://example.com/admin/logs", "//example.com/admin/logs", "/api/secret", "/admin/\\evil"]) {
      expect(AppStatusSummaryDataSchema.safeParse({ ...data, apps: [{ ...data.apps[0], links: [{ label: "Open", href }] }] }).success).toBe(
        false,
      );
    }
    expect(
      AppStatusDetailDataSchema.safeParse({
        routes: [],
        failedRequests: Array(51).fill({ at: "2026-10-30T12:00:00Z", method: "GET", path: "/app/mail", status: 503 }),
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
  test("compiles and retains a compatible role", () => {
    const manifest = appStatusManifest();
    expect(appStatusIssues(manifest)).toEqual([]);
    expect(CapabilityManifestSchema.parse(manifest).appStatus).toEqual(appStatusDeclaration.appStatus);
    const entry = resolveLiveCapabilityRegistryEntry(
      "capabilities/monitor",
      {
        appId: "monitor",
        appName: "Monitor",
        appIcon: "box",
        appDescription: "Monitor",
        endpoint: "http://monitor/capabilities",
        manifest,
      },
      {
        id: "monitor",
        name: "Monitor",
        icon: "box",
        description: "Monitor",
        baseUrl: "http://monitor",
        routes: ["/app/monitor"],
        capabilities: { protocolVersion: 2, manifestHash: manifest.manifestHash },
      },
    );
    expect(entry?.manifest.appStatus).toEqual(appStatusDeclaration.appStatus);
  });
  test("rejects incompatible declarations at startup and removes broken role references from readers", () => {
    expect(() =>
      compileCapabilities("monitor", {
        ...appStatusDeclaration,
        queries: {
          ...appStatusDeclaration.queries,
          "status.summary": {
            ...appStatusDeclaration.queries["status.summary"],
            input: z
              .object({ appIds: z.array(z.string()).max(2).describe("Apps."), window: z.literal("24h").describe("Window.") })
              .strict(),
          },
        },
      }),
    ).toThrow("appStatus");
    const manifest = appStatusManifest();
    expect(
      CapabilityManifestSchema.parse({ ...manifest, appStatus: { ...manifest.appStatus, summary: "absent" } }).appStatus,
    ).toBeUndefined();
    expect(appStatusIssues({ ...manifest, actions: [] }).length).toBeGreaterThan(0);
  });
  test("counts raw response bytes including whitespace before schema validation", async () => {
    const raw = " ".repeat(1024) + '{"data":{}}';
    let charged = 0;
    const result = await readBoundedJson(new Response(raw), 2048, undefined, (bytes) => {
      charged += bytes;
    });
    expect(result).toEqual({ ok: true, data: { data: {} } });
    expect(charged).toBe(Buffer.byteLength(raw));
    const rejected = await readBoundedJson(new Response(raw), 2048, undefined, () => {
      throw new Error("budget spent");
    });
    expect(rejected.ok).toBe(false);
  });
});
