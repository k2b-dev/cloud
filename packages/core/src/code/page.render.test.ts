import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCodeSdk, validateCodePage } from "@k2b/cloud/code";
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
const { codePageFixture } = await import("./page.test-fixture");
const { CODE_INITIAL_PAGE_SOURCE } = await import("./authoring-contracts");
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
test("the server draws every block with shared components, including the chart and the scan control", () => {
  const full = validateCodePage(codePageFixture, "c_page");
  const html = renderToString(() => createComponent(Page, { tree: full, codeId: "c_page", csrf: "session-bound", locale: "en" }));
  for (const kind of [
    "Notice",
    "Stats",
    "Text",
    "Section",
    "Chart",
    "Table",
    "Form",
    "Detail",
    "Heading",
    "Actions",
    "Button",
    "Action",
    "Link",
  ])
    expect(html).toContain(`data-code-block="${kind}"`);
  // A drawn chart, not only its data table.
  expect(html).toMatch(/<svg[^>]*stdlib-chart|class="[^"]*k2b-chart/);
  expect(html).toContain("Items per status");
  // The empty table names its state; the field shows the Code's validation message.
  expect(html).toContain("Nothing waits.");
  expect(html).toContain("No item has this code.");
  expect(html).toContain('aria-label="Scan"');
  // Detail values in the reader's language; both actions share one row.
  expect(html).toContain("1,200");
  expect(html).toContain("Yes");
  expect(html.match(/data-code-block="Actions"/g)).toHaveLength(1);
  // The page head, key figures with change and comparison, section symbols and panel widths.
  expect(html).toContain("As of 7 Nov 2026, 09:40");
  expect(html).toContain('class="ti ti-tool"');
  expect(html).toContain("+12.3%");
  expect(html).toContain("Last week €4,002.00");
  expect(html).toContain("2.4 d");
  expect(html).toContain("€95.50");
  expect(html).toMatch(/class="ti ti-calendar-event text-lg"/);
  expect(html).toContain("col-span-6 @[62.5rem]:col-span-4 min-w-0 p-4");
  // A chart with nothing to draw keeps its frame and title and says why.
  const waiting = validateCodePage(
    { version: 1, kind: "Page", title: "Empty", children: [{ kind: "Chart", title: "Items per status", empty: "No item arrived today." }] },
    "c_page",
  );
  const empty = renderToString(() => createComponent(Page, { tree: waiting, codeId: "c_page", csrf: "session-bound", locale: "en" }));
  expect(empty).toContain("Items per status");
  expect(empty).toContain("No item arrived today.");
  const german = renderToString(() => createComponent(Page, { tree: full, codeId: "c_page", csrf: "session-bound", locale: "de" }));
  expect(german).toContain("1.200");
  expect(german).toContain('aria-label="Scannen"');
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

test("the cld code init page runs through the SDK blocks and Core draws it", async () => {
  // The template as Code runs it: TSX through the SDK's jsx factory, then the route's description.
  const directory = mkdtempSync(join(tmpdir(), "core-code-init-page-"));
  writeFileSync(join(directory, "sdk.js"), generateCodeSdk([], { mode: "personal" }).runtime);
  const source = CODE_INITIAL_PAGE_SOURCE.replace('"@sdk"', '"./sdk.js"').replace("import { app,", "import { __codeSdk, app,");
  const transpiler = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "jsx" } } });
  writeFileSync(join(directory, "code.mjs"), `${transpiler.transformSync(source)}\nexport { __codeSdk };`);
  const module = await import(join(directory, "code.mjs"));
  const response = await module.__codeSdk.run("route:GET:/", {
    method: "GET",
    path: "/",
    query: "",
    contentType: "text/plain",
    body: "",
    params: {},
    user: { id: "visitor", groups: [] },
  });
  const page = validateCodePage(response.tree, "c_init");
  const html = renderToString(() => createComponent(Page, { tree: page, codeId: "c_init", csrf: "session-bound", locale: "en" }));
  for (const kind of ["Stats", "Section", "Chart", "Form", "Table"]) expect(html).toContain(`data-code-block="${kind}"`);
  expect(html).toContain("Done per day");
  expect(html).toContain('name="title"');
  expect(html).toContain("Order chairs");
});
