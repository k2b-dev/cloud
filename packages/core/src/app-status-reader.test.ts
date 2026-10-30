import { describe, expect, spyOn, test } from "bun:test";
import type { CapabilityCatalogApp, CapabilityInvocation } from "@k2b/cloud/capabilities/server";
import { adminAuthority, appStatusManifest } from "../../../scripts/fixtures/app-status";
import { type AppStatusDependencies, createAppStatusReader } from "./app-status-reader";

const provider = (appId: string): CapabilityCatalogApp => ({
  appId,
  appName: appId,
  appIcon: "box",
  appDescription: "Monitor",
  manifest: appStatusManifest(appId),
});
const catalog = (apps: CapabilityCatalogApp[]) => ({
  ok: true as const,
  data: { protocolVersion: 2 as const, apps, page: { hasMore: false as const, nextCursor: null } },
});
const summary = () => ({
  ok: true as const,
  data: {
    data: {
      apps: [
        {
          appId: "mail",
          traffic: null,
          links: [
            { kind: "logs" as const, label: "Protokolle", href: "/admin/monitoring" },
            { label: "More", href: "/admin/more" },
          ],
          lastSeenAt: null,
        },
      ],
      otherApps: [],
    },
  },
});
const params = () => ({ authority: adminAuthority(), locale: "de", appIds: ["mail"], window: "24h" as const });

describe("request-local app-status reader", () => {
  test("preserves authority, locale and provenance; isolates denied and invalid providers", async () => {
    const input = params();
    const seen: CapabilityInvocation[] = [];
    const reader = createAppStatusReader({
      catalog: async (options) => {
        expect(options.caller.authority).toBe(input.authority);
        return catalog([provider("healthy"), provider("denied"), provider("invalid")]);
      },
      invoke: async (call, caller) => {
        seen.push(call);
        expect(caller.authority).toBe(input.authority);
        expect(caller.locale).toBe("de");
        if (call.appId === "denied") return { ok: false, error: { code: "FORBIDDEN", status: 403, message: "Denied" } };
        return call.appId === "invalid" ? { ok: true, data: { data: { apps: "broken" } } } : summary();
      },
    });
    const result = await reader.readAppStatusSummaries(input);
    expect(result.byApp.get("mail")?.[0]?.provider.appId).toBe("healthy");
    expect(result.byApp.get("mail")?.[0]?.links).toEqual(summary().data.data.apps[0]?.links);
    expect(result.failures.map((f) => [f.provider.appId, f.reason])).toEqual([
      ["denied", "denied"],
      ["invalid", "invalid"],
    ]);
    expect(seen).toHaveLength(3);
  });
  test("slow discovery and providers share the same deadline", async () => {
    const now = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const reader = createAppStatusReader({
        catalog: async () => {
          now.mockReturnValue(2_400);
          return catalog([provider("slow")]);
        },
        invoke: async () => {
          now.mockReturnValue(2_501);
          return summary();
        },
      });
      const result = await reader.readAppStatusSummaries(params());
      expect(result.failures.map((f) => f.reason)).toEqual(["timeout"]);
      expect(result.byApp.size).toBe(0);
    } finally {
      now.mockRestore();
    }
  });
  test("ends stalled discovery and aborts stalled providers without losing completed rows", async () => {
    const reader = createAppStatusReader({
      catalog: async () => catalog([provider("healthy"), provider("slow")]),
      invoke: async (call) => (call.appId === "healthy" ? summary() : new Promise(() => {})),
    });
    const result = await reader.readAppStatusSummaries(params());
    expect(result.byApp.get("mail")).toHaveLength(1);
    expect(result.failures).toEqual([{ provider: { appId: "slow", name: "slow" }, reason: "timeout" }]);
  });
  test("counts oversized and invalid payloads against one cumulative budget", async () => {
    const deps: AppStatusDependencies = {
      catalog: async () => catalog([provider("first"), provider("second"), provider("third")]),
      invoke: async (call) => ({ ok: true, data: { data: { padding: "x".repeat(call.appId === "first" ? 300_000 : 240_000) } } }),
    };
    const result = await createAppStatusReader(deps).readAppStatusSummaries(params());
    expect(result.failures.map((f) => f.reason)).toEqual(["invalid", "unavailable", "unavailable"]);
  });
  test("shares eight providers and four concurrent calls across summary and detail", async () => {
    const input = params();
    let active = 0;
    let peak = 0;
    let catalogCalls = 0;
    const reader = createAppStatusReader({
      catalog: async () => {
        catalogCalls++;
        return catalog(Array.from({ length: 9 }, (_, n) => provider(`monitor-${n}`)));
      },
      invoke: async (call) => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return call.capabilityId.endsWith("detail")
          ? { ok: true, data: { data: { routes: [], failedRequests: [], nextCursor: null } } }
          : summary();
      },
    });
    const [summaries, details] = await Promise.all([
      reader.readAppStatusSummaries(input),
      reader.readAppStatusDetail({ ...input, appId: "mail" }),
    ]);
    expect(peak).toBeLessThanOrEqual(4);
    expect(catalogCalls).toBe(1);
    expect(summaries.byApp.get("mail")).toHaveLength(8);
    expect(details.results).toHaveLength(8);
    expect(summaries.failures).toContainEqual({ provider: { appId: "monitor-8", name: "monitor-8" }, reason: "unavailable" });
  });
  test("reports request truncation and provider-only timestamps", async () => {
    let requested = 0;
    const result = await createAppStatusReader({
      catalog: async () => catalog([provider("monitor")]),
      invoke: async (call) => {
        const input = call.input;
        if (input && typeof input === "object" && "appIds" in input && Array.isArray(input.appIds)) requested = input.appIds.length;
        return {
          ok: true,
          data: {
            data: { apps: [{ appId: "offline", traffic: null, links: [], lastSeenAt: "2026-10-01T12:00:00Z" }], otherApps: ["offline"] },
          },
        };
      },
    }).readAppStatusSummaries({ ...params(), appIds: Array.from({ length: 203 }, (_, n) => `app-${n}`) });
    expect(requested).toBe(200);
    expect(result.truncated).toEqual(["app-200", "app-201", "app-202"]);
    expect(result.otherApps[0]?.lastSeenAt).toBe("2026-10-01T12:00:00Z");
  });
  test("fails forget when a remembered provider is offline and routes cursors only to their provider", async () => {
    const input = params();
    const seen: string[] = [];
    const reader = createAppStatusReader({
      catalog: async () => catalog([provider("monitor")]),
      invoke: async (call) => {
        seen.push(call.appId);
        return call.kind === "action"
          ? { ok: true, data: { data: { forgotten: true } } }
          : call.capabilityId.endsWith("detail")
            ? { ok: true, data: { data: { routes: [], failedRequests: [], nextCursor: null } } }
            : summary();
      },
    });
    const removed = await reader.forgetAppStatus({ ...input, appId: "mail", requiredProviders: [{ appId: "offline", name: "Offline" }] });
    expect(removed.failures).toContainEqual({ provider: { appId: "offline", name: "Offline" }, reason: "unavailable" });
    seen.length = 0;
    await reader.readAppStatusDetail({ ...input, appId: "mail", providerAppId: "monitor", cursor: "next" });
    expect(seen).toEqual(["monitor"]);
    const absent = await reader.readAppStatusDetail({ ...input, appId: "mail", providerAppId: "offline", cursor: "next" });
    expect(absent.failures).toContainEqual({ provider: { appId: "offline", name: "offline" }, reason: "unavailable" });
    expect(seen).toEqual(["monitor"]);
  });
  test("accounts raw bytes before a valid parsed result and respects cancellation", async () => {
    const input = params();
    const controller = new AbortController();
    const reader = createAppStatusReader({
      catalog: async () => catalog([provider("monitor")]),
      invoke: async (_call, caller) => {
        try {
          caller.consumeResponseBytes?.(512 * 1024 + 1);
        } catch {
          /* Transport converts a byte-budget rejection to a client failure. */
        }
        return summary();
      },
    });
    expect((await reader.readAppStatusSummaries(input)).failures[0]?.reason).toBe("unavailable");
    controller.abort();
    expect(
      (
        await createAppStatusReader({ catalog: async () => catalog([]), invoke: async () => summary() }).readAppStatusSummaries({
          ...input,
          signal: controller.signal,
        })
      ).failures[0]?.reason,
    ).toBe("timeout");
  });
  test("fails closed for discovery errors and non-admin authority", async () => {
    let calls = 0;
    const deps: AppStatusDependencies = {
      catalog: async () => ({ ok: false, error: { code: "APP_UNAVAILABLE", status: 503, message: "Unavailable" } }),
      invoke: async () => {
        calls++;
        return summary();
      },
    };
    expect((await createAppStatusReader(deps).readAppStatusSummaries(params())).failures[0]?.reason).toBe("unavailable");
    const input = params();
    if (input.authority.actor.kind === "user") input.authority.actor.user.roles = [];
    expect((await createAppStatusReader(deps).readAppStatusSummaries(input)).failures[0]?.reason).toBe("denied");
    expect(calls).toBe(0);
  });
});
