import { expect, test } from "bun:test";
import type { CapabilityCatalogApp } from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { catalogCapabilities } from "./capabilities";
import { createSearchCatalogLoader, filterSearchCatalog } from "./search";

const app = (id: string): CapabilityCatalogApp => ({
  appId: id,
  appName: id,
  appIcon: "ti ti-apps",
  appDescription: "Inspect available interfaces",
  manifest: compileCapabilityManifest(id, catalogCapabilities),
});

test("catalog search reads all pages once per locale and opens inspector links only", async () => {
  const calls: unknown[] = [];
  const load = createSearchCatalogLoader(async (input) => {
    calls.push(input);
    return {
      ok: true,
      data: {
        protocolVersion: 2,
        apps: [app(input?.cursor ? "other" : "catalog")],
        page: input?.cursor ? { hasMore: false } : { hasMore: true, nextCursor: "other" },
      },
    };
  });
  const views = await load("de-DE");
  expect(views).toHaveLength(4);
  expect(views.every((view) => view.links?.[0]?.href.startsWith("/app/capabilities/"))).toBe(true);
  const results = filterSearchCatalog(views, { query: "other search", tags: [], limit: 1 });
  expect(results).toHaveLength(1);
  expect(results[0]?.links).toEqual([{ rel: "open", href: "/app/capabilities/other/query/search" }]);
  expect(await load("de")).toEqual(views);
  expect(calls).toHaveLength(2);
  await load("en-US");
  expect(calls).toHaveLength(4);
});

test("failed catalog loads are retryable and cursor loops fail closed", async () => {
  let fail = true;
  const load = createSearchCatalogLoader(async () =>
    fail
      ? { ok: false, error: { code: "UNAVAILABLE", message: "offline", status: 503 } }
      : { ok: true, data: { protocolVersion: 2, apps: [app("catalog")], page: { hasMore: false } } },
  );
  await expect(load("en")).rejects.toThrow("offline");
  fail = false;
  expect(await load("en")).toHaveLength(2);
  let reads = 0;
  const loop = createSearchCatalogLoader(async () => {
    reads++;
    return { ok: true, data: { protocolVersion: 2, apps: [], page: { hasMore: true, nextCursor: "same" } } };
  });
  await expect(loop("en")).rejects.toThrow("cursor did not advance");
  expect(reads).toBe(2);
});
