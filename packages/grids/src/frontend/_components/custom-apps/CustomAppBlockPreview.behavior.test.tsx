import { describe, expect, test } from "bun:test";
import { createComponent, createSignal, ErrorBoundary } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicDslQueryPreviewResponse } from "../../../api/gql-public";
import type { CustomAppBlock } from "../../../custom-apps/contracts";
import type { CustomAppCatalog } from "./custom-app-catalog";

const catalog: CustomAppCatalog = {
  customApps: [],
  workflows: [],
  workflowLaunchers: [],
  workflowLevels: {},
  tables: [],
  tableLevels: {},
  fieldsByTable: {},
  viewsByTable: {},
  formsByTable: {},
  documentTemplatesByTable: {},
  documentTemplateLevels: {},
  sidebarForms: [],
  sidebarDocumentTemplates: [],
};
const block = (query = "from table Items"): CustomAppBlock => ({
  id: "metric",
  type: "metrics",
  source: { kind: "gql", query },
});
const success = (value: string): PublicDslQueryPreviewResponse => ({
  ok: true,
  mode: "rows",
  columns: [{ key: "value", label: "Result", type: "text", sqlType: "text" }],
  rows: [{ values: { value } }],
  limit: 1,
});
const flush = async () => {
  await Bun.sleep(20);
};

describe("Custom App block preview recovery", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  async function setup(initialResult?: PublicDslQueryPreviewResponse) {
    const dom = createDomTestHarness();
    const { default: Preview } = await import("./CustomAppBlockPreview");
    const originalFetch = globalThis.fetch;
    const pending: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
    const results: PublicDslQueryPreviewResponse[] = [];
    globalThis.fetch = Object.assign(
      () => {
        const request = Promise.withResolvers<Response>();
        pending.push(request);
        return request.promise;
      },
      { preconnect: originalFetch.preconnect },
    );
    const [current, setBlock] = createSignal(block());
    const dispose = render(
      () =>
        createComponent(ErrorBoundary, {
          fallback: () => "Escaped preview error",
          get children() {
            return createComponent(Preview, {
              baseId: "BASE01",
              appId: "APP001",
              catalog,
              initialResult,
              get block() {
                return current();
              },
              onPreviewResult: (_id, result) => results.push(result),
            });
          },
        }),
      dom.root,
    );
    return {
      dom,
      pending,
      results,
      setBlock,
      cleanup() {
        dispose();
        dom.cleanup();
        globalThis.fetch = originalFetch;
      },
    };
  }

  for (const failure of ["network", "http"] as const) {
    test(`${failure} failure stays local and reload recovers`, async () => {
      const harness = await setup();
      const { dom, pending, results } = harness;
      try {
        expect(dom.root.textContent).toContain("Loading preview");
        if (failure === "network") pending[0]!.reject(new TypeError("Network unavailable"));
        else pending[0]!.resolve(Response.json({ error: "Unavailable" }, { status: 503 }));
        await flush();
        expect(dom.root.textContent).not.toContain("Escaped preview error");
        expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("The preview could not be loaded.");
        expect(results).toEqual([]);
        const retry = dom.root.querySelector("button");
        expect(retry?.textContent).toContain("Reload preview");
        retry!.click();
        expect(dom.root.textContent).toContain("Loading preview");
        expect(pending).toHaveLength(2);
        pending[1]!.resolve(Response.json(success("Recovered")));
        await flush();
        expect(dom.root.textContent).toContain("Recovered");
        expect(dom.root.querySelector('[role="alert"]')).toBeNull();
        expect(results).toEqual([success("Recovered")]);
      } finally {
        harness.cleanup();
      }
    });
  }

  test("seeded preview survives failed source changes and ignores stale completions", async () => {
    const harness = await setup(success("Seeded"));
    const { dom, pending, results, setBlock } = harness;
    try {
      expect(dom.root.textContent).toContain("Seeded");
      expect(pending).toHaveLength(0);
      setBlock(block("from table Missing"));
      pending[0]!.reject(new TypeError("Offline"));
      await flush();
      expect(dom.root.querySelector('[role="alert"]')).not.toBeNull();
      setBlock(block("from table Old"));
      setBlock(block("from table Latest"));
      pending[2]!.resolve(Response.json(success("Latest result")));
      await flush();
      pending[1]!.resolve(Response.json(success("Stale result")));
      await flush();
      expect(dom.root.textContent).toContain("Latest result");
      expect(dom.root.textContent).not.toContain("Stale result");
      expect(dom.root.textContent).not.toContain("Escaped preview error");
      expect(results).toContainEqual(success("Latest result"));
      expect(results).not.toContainEqual(success("Stale result"));
    } finally {
      harness.cleanup();
    }
  });

  test("domain diagnostics remain visible and are reported to the builder", async () => {
    const harness = await setup();
    const { dom, pending, results } = harness;
    const diagnostic: PublicDslQueryPreviewResponse = {
      ok: false,
      diagnostics: [{ message: "Choose an existing table.", code: "gql.resolution" }],
    };
    try {
      pending[0]!.resolve(Response.json(diagnostic));
      await flush();
      expect(dom.root.textContent).toContain("Data unavailable");
      expect(dom.root.textContent).toContain("Choose an existing table.");
      expect(dom.root.textContent).not.toContain("Reload preview");
      expect(results).toEqual([diagnostic]);
    } finally {
      harness.cleanup();
    }
  });
});
