import { describe, expect, test } from "bun:test";
import type {
  CapabilityCatalogApp,
  CapabilityCatalogAppClientResult,
  CapabilityCatalogClientResult,
} from "@k2b/cloud/capabilities/server";
import { loadCapabilityWorkspace } from "./catalog";

const hash = "a".repeat(64);

const app = (appId: string, appName = appId): CapabilityCatalogApp => ({
  appId,
  appName,
  appIcon: "ti ti-apps",
  appDescription: `${appName} capabilities`,
  manifest: { protocolVersion: 1, appId, manifestHash: hash, types: [], queries: [], actions: [] },
});

describe("capability workspace catalog", () => {
  test("loads every catalog page for the workspace app list", async () => {
    const calls: Array<string | undefined> = [];
    const pages = new Map<string | undefined, CapabilityCatalogClientResult>([
      [undefined, { ok: true, data: { protocolVersion: 1, apps: [app("zeta", "Zeta")], page: { hasMore: true, nextCursor: "page-2" } } }],
      ["page-2", { ok: true, data: { protocolVersion: 1, apps: [app("alpha", "Alpha")], page: { hasMore: false } } }],
    ]);
    const list = async (options: { cursor?: string } = {}): Promise<CapabilityCatalogClientResult> => {
      calls.push(options.cursor);
      return pages.get(options.cursor) ?? { ok: false, error: { code: "NOT_FOUND", message: "missing page", status: 404 } };
    };
    const get = async (): Promise<CapabilityCatalogAppClientResult> => ({ ok: true, data: app("alpha", "Alpha") });

    const workspace = await loadCapabilityWorkspace("alpha", { list, get });

    expect(calls).toEqual([undefined, "page-2"]);
    expect(workspace.apps.map((entry) => entry.id)).toEqual(["alpha", "zeta"]);
  });

  test("deduplicates apps and stops a repeated cursor", async () => {
    let calls = 0;
    const list = async (options: { cursor?: string } = {}): Promise<CapabilityCatalogClientResult> => {
      calls += 1;
      return {
        ok: true,
        data: {
          protocolVersion: 1,
          apps: [app("mail", options.cursor ? "Mail updated" : "Mail")],
          page: { hasMore: true, nextCursor: "same" },
        },
      };
    };
    const get = async (): Promise<CapabilityCatalogAppClientResult> => ({ ok: true, data: app("mail", "Mail updated") });

    const workspace = await loadCapabilityWorkspace("mail", { list, get });

    expect(calls).toBe(2);
    expect(workspace.apps).toHaveLength(1);
    expect(workspace.apps[0]?.name).toBe("Mail updated");
  });
});
