import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { launchBrowser, pageErrors } from "../../../ui/test/browser";

// Exercise the real renderer: shared controls must submit the edited value, not the initial tree.
test("page form edits submit through native POST with own action and CSRF", async () => {
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  const entry = resolve(import.meta.dir, "page.browser-entry.ts");
  const tree = {
    version: 1,
    kind: "Page",
    title: "Workshop",
    children: [
      {
        kind: "Form",
        title: "Edit",
        action: "/save",
        submit: "Save",
        fields: [
          { type: "scan", name: "barcode", label: "Barcode", value: "initial" },
          { type: "number", name: "count", label: "Count", value: 1 },
          { type: "checkbox", name: "ready", label: "Ready", value: false },
          {
            type: "select",
            name: "status",
            label: "Status",
            value: "open",
            options: [
              { value: "open", label: "Open" },
              { value: "done", label: "Done" },
            ],
          },
        ],
      },
    ],
  };
  const fixture = `import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import Page from "./PageTree.island";
render(() => createComponent(Page, { tree: ${JSON.stringify(tree)}, codeId: "c_page", csrf: "session-bound", locale: "en" }), document.getElementById("app"));`;
  const bundle = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: fixture },
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "code-page-dom",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const transformed = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: transformed.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile Code page");
  const script = await bundle.outputs[0]!.text();
  let submitted: { path: string; fields: Record<string, string> } | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "POST") {
        submitted = { path: new URL(request.url).pathname, fields: Object.fromEntries(new URLSearchParams(await request.text())) };
        return Response.json({ saved: true });
      }
      return new Response(
        '<!doctype html><html lang="en"><head><title>Page</title></head><body class="k2b-ui"><div id="app"></div></body></html>',
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    const errors = pageErrors(page);
    await page.goto(server.url.href);
    await page.addStyleTag({ path: resolve(ui, "dist/styles.css") });
    await page.addScriptTag({ content: script });
    await page.getByLabel("Barcode", { exact: true }).fill("edited");
    await page.getByLabel("Count", { exact: true }).fill("3");
    await page.getByLabel("Ready", { exact: true }).check();
    await page.getByRole("combobox", { name: "Status", exact: true }).click();
    await page.getByRole("option", { name: "Done", exact: true }).click();
    await Promise.all([page.waitForURL("**/code/c_page/save"), page.getByRole("button", { name: "Save", exact: true }).click()]);
    expect(submitted).toEqual({
      path: "/code/c_page/save",
      fields: { _csrf: "session-bound", barcode: "edited", count: "3", ready: "on", status: "done" },
    });
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await server.stop(true);
  }
}, 30000);
