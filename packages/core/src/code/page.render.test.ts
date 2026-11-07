import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCodePage } from "@k2b/cloud/code";
import type { CodeCheckedVersionManifest } from "@k2b/cloud/contracts";
import * as server from "@k2b/cloud/server";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "core-code-page-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
const { default: Page } = await import("./PageTree.island");
const { createCodeHostingRoutes } = await import("./hosting");
const tree = validateCodePage(
  {
    version: 1,
    kind: "Page",
    title: "<script>Workshop</script>",
    children: [
      { kind: "Text", text: "<svg onload=alert(1)>" },
      { kind: "Table", title: "Items", columns: [{ key: "title", label: "Title" }], rows: [{ title: "One" }] },
      {
        kind: "Form",
        title: "Find",
        action: "/find",
        submit: "Find",
        fields: [
          { type: "scan", name: "barcode", label: "Barcode" },
          { type: "select", name: "status", label: "Status", value: "open", options: [{ label: "Open", value: "open" }] },
        ],
      },
      { kind: "Button", label: "Save", action: "/save", values: { id: "one" } },
      { kind: "Chart", description: { kind: "bar", title: "Count", data: [{ label: "One", value: 2 }] } },
      { kind: "Link", label: "Next", href: "/next" },
      { kind: "Detail", title: "Info", items: [{ label: "Code", value: "one" }] },
      { kind: "Notice", tone: "success", title: "Saved" },
    ],
  },
  "c_page",
);
test("SSR renders escaped content, own links, chart data and usable form controls with CSRF", () => {
  const html = renderToString(() => createComponent(Page, { tree, codeId: "c_page", csrf: "session-bound", locale: "en" }));
  expect(html).toContain("&lt;script>Workshop&lt;/script>");
  expect(html).not.toContain("<svg onload");
  expect(html).toContain('action="/code/c_page/find"');
  expect(html).toContain('method="post"');
  expect(html).toContain('name="_csrf" value="session-bound"');
  expect(html).toContain('name="barcode"');
  expect(html).toContain('name="status"');
  expect(html).toContain('href="/code/c_page/next"');
  expect(html).toContain("Count");
  expect(html).toContain("Info");
});
test("Core hosts a complete page document and rejects invalid trees before rendering", async () => {
  const rate = spyOn(server, "ratelimit").mockImplementation(({ id }) => ({
    id,
    check: async () => ({ limited: false, remaining: 1, resetIn: 1 }),
    checkOrThrow: async () => ({ limited: false, remaining: 1, resetIn: 1 }),
  }));
  const manifest: CodeCheckedVersionManifest = {
    version: 1,
    entry: "code.tsx",
    entrypoints: [
      {
        kind: "route",
        entrypoint: "route:GET:/",
        route: { method: "GET", path: "/", public: true },
        cron: null,
        file: "code.tsx",
        line: 1,
      },
    ],
    permissions: [],
    ai: false,
    policyRows: ["public_routes"],
    hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
  };
  let returned: unknown = tree;
  const router = new Hono().route(
    "/",
    createCodeHostingRoutes({
      version: async () => ({ versionId: "version", manifest, personalOwner: null }),
      request: async () => ({ kind: "page", status: 200, tree: returned }),
    }),
  );
  try {
    const response = await router.request("https://cloud.test/code/c_page/");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html.toLowerCase()).toContain("<!doctype html>");
    expect(html).toContain("data-code-page-version");
    expect(html).toContain("PageTree.island.tsx");
    expect(html).not.toContain("data-cloud-shell");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const head = await router.request("https://cloud.test/code/c_page/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    returned = { ...tree, children: [{ kind: "HTML", html: "<script>bad</script>" }] };
    const invalid = await router.request("https://cloud.test/code/c_page/");
    expect(invalid.status).toBe(503);
    expect(await invalid.text()).not.toContain("<script>");
  } finally {
    rate.mockRestore();
  }
});
