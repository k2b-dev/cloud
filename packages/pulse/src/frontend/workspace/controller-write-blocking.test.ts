import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { prompts } from "@k2b/ui";
import { createRoot } from "solid-js";
import type { PulseSource } from "../../contracts";

const root = mkdtempSync(join(tmpdir(), "pulse-source-controller-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { createSourceController } = await import("./source-controller");

const source: PulseSource = {
  id: "source-1",
  baseId: "base-1",
  kind: "http_ingest",
  name: "Ingest",
  enabled: true,
  endpointUrl: null,
  bearerTokenConfigured: false,
  scrapeIntervalSeconds: null,
  metricFilters: [],
  status: {
    newestDataAt: null,
    throttled: false,
    throttledAt: null,
    refusedHistograms: [],
    skippedSummaries: 0,
    lastError: null,
    lastErrorAt: null,
  },
  lastSeenAt: null,
  lastError: null,
  lastErrorAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("Pulse write controllers do not repeat a write while canonical data is stale", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return Response.json({});
  }) as unknown as typeof fetch;
  let dispose = () => {};
  const controller = createRoot((nextDispose) => {
    dispose = nextDispose;
    return createSourceController({
      selectedBaseId: () => "base-1",
      loading: () => false,
      setLoading: () => false,
      selectedSourceId: () => "",
      navigate: () => undefined,
      refreshBaseData: () => Promise.resolve(),
      refreshSourceDetail: () => Promise.resolve(),
      writeBlocked: () => true,
    });
  });

  try {
    await expect(controller.createApiKey(source, { name: "Blocked", expiresAt: null, permission: "write" })).rejects.toThrow(
      "Refresh Pulse data before making more changes.",
    );
    expect(requests).toBe(0);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
  }
});

test("removing the open source returns to the sources URL", async () => {
  const originalFetch = globalThis.fetch;
  const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
  const requests: string[] = [];
  const destinations: Array<{ view: string; sourceId?: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  let dispose = () => {};
  const controller = createRoot((nextDispose) => {
    dispose = nextDispose;
    return createSourceController({
      selectedBaseId: () => "base-1",
      selectedSourceId: () => source.id,
      loading: () => false,
      setLoading: () => false,
      navigate: (state) => {
        destinations.push(state);
      },
      refreshBaseData: () => Promise.resolve(),
      refreshSourceDetail: () => Promise.resolve(),
      writeBlocked: () => false,
    });
  });
  try {
    await controller.removeSource(source);
    expect(requests).toEqual(["/api/pulse/bases/base-1/sources/source-1"]);
    expect(destinations).toEqual([{ view: "sources" }]);
  } finally {
    dispose();
    confirm.mockRestore();
    globalThis.fetch = originalFetch;
  }
});
