import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createComponent } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createConfig } from "../../src/index";

describe("createConfig() cache busting", () => {
  test("uses version 0 without island build output or preloads", async () => {
    const { html } = createConfig({ dev: false, template: ({ scripts }) => scripts });
    const response = await html(() => "content");
    const output = await response.text();
    expect(output).not.toContain("modulepreload");
    expect(output).toContain('<script type="module" data-ssr-assets=');

    expect(output).toBe(
      `<style>solid-client,solid-island{display:contents}</style>\n<script type="module" data-ssr-assets="/_ssr/0">const p="/_ssr/0";document.querySelectorAll('solid-island,solid-client').forEach(e=>import(p+'/'+e.dataset.id+'.js'));</script>`,
    );
  });

  test("keeps hydration imports unversioned in dev mode", async () => {
    const { html } = createConfig({ dev: true });
    const response = await html(() => "content");
    const output = await response.text();
    expect(output).not.toContain("modulepreload");
    expect(output).toContain('<script type="module" data-ssr-assets=');

    expect(output).toContain('const p="/_ssr"');
    expect(output).not.toContain("?v=");
  });

  test("uses basePath for hydration imports and dev config", async () => {
    const { html } = createConfig({ dev: true, basePath: "/docs" });
    const response = await html(() => "content");
    const output = await response.text();
    expect(output).not.toContain("modulepreload");
    expect(output).toContain('<script type="module" data-ssr-assets=');

    expect(output).toContain('const p="/docs/_ssr"');
    expect(output).toMatch(/globalThis\.__SSR_CONFIG=\{"ssrPath":"\/docs\/_ssr","reloadId":"[0-9a-f-]{36}"\}/);
  });

  test("uses version 0 under normalized basePath without island build output", async () => {
    const { html } = createConfig({ dev: false, basePath: "/docs/" });
    const response = await html(() => "content");
    const output = await response.text();
    expect(output).not.toContain("modulepreload");
    expect(output).toContain('<script type="module" data-ssr-assets=');

    expect(output).toContain('const p="/docs/_ssr/0"');
  });

  test("rejects invalid basePath values", () => {
    expect(() => createConfig({ basePath: "docs" })).toThrow(/basePath must start with "\/" or be empty/);
  });

  test("rejects async render functions", async () => {
    const { html } = createConfig({ dev: false });

    // @ts-expect-error the runtime guard rejects what the type already forbids
    await expect(html(async () => "content")).rejects.toThrow("html() expects a synchronous render function");
  });
});

describe("swap-host loader", () => {
  const renderLoader = async (body: string, dev = true) => {
    const { html } = createConfig({ dev, template: ({ scripts }) => scripts });
    const output = await (await html(() => createComponent(Dynamic, { component: "div", innerHTML: body }))).text();
    const loader = output.match(/<script type="module"[^>]*>([^<]+)<\/script>/)?.[1];
    if (!loader) throw new Error("Missing loader");
    return loader;
  };
  const wrapper = (id: string) => `<solid-island data-id="${id}"></solid-island>`;

  test("keeps the original loader unless the body declares the data-nav-root attribute", async () => {
    const original =
      "const p=\"/_ssr\";document.querySelectorAll('solid-island,solid-client').forEach(e=>import(p+'/'+e.dataset.id+'.js'));";
    for (const body of ["", '<main data-nav-root-extra="">', '<main class="data-nav-root">'])
      expect(await renderLoader(body)).toBe(original);
    for (const dev of [false, true]) {
      for (const attr of ['data-nav-root=""', "data-nav-root", 'data-nav-root class="column"']) {
        const loader = await renderLoader(`<main ${attr}></main>`, dev);
        expect(loader).toStartWith(`const p="/_ssr${dev ? "" : "/0"}";`);
        expect(loader).toContain("Promise.allSettled");
        expect(loader).toContain("[data-nav-shell] [data-nav-root]");
      }
    }
  });

  test("preloads distinct column entries but evaluates them only after all shell imports settle", async () => {
    const body = `<div data-nav-shell>${wrapper("shell")}${wrapper("shell")}${wrapper("broken")}<main data-nav-root>${wrapper("column")}${wrapper("column")}</main></div>`;
    const loader = await renderLoader(body);
    const dom = new Window({ settings: { disableCSSFileLoading: true } });
    try {
      dom.document.body.innerHTML = body;
      const sequence: string[] = [];
      const shell = Promise.withResolvers<void>();
      const column = Promise.withResolvers<void>();
      // Replace only the import operation; execute the shipped control flow against Happy DOM.
      new Function("document", "load", loader.replaceAll("import(", "load("))(dom.document, (url: string) => {
        sequence.push(url);
        expect([...dom.document.head.querySelectorAll("link")].map((link) => link.getAttribute("href"))).toEqual(["/_ssr/column.js"]);
        if (url === "/_ssr/shell.js") return shell.promise;
        if (url === "/_ssr/broken.js") return Promise.reject(new Error("shell failed"));
        column.resolve();
        return Promise.resolve();
      });
      await Promise.resolve();
      expect(sequence).toEqual(["/_ssr/shell.js", "/_ssr/broken.js"]);
      shell.resolve();
      await column.promise;
      expect(sequence).toEqual(["/_ssr/shell.js", "/_ssr/broken.js", "/_ssr/column.js"]);
    } finally {
      await dom.happyDOM.close();
    }
  });

  test("without a column inside a shell, imports every wrapper as before", async () => {
    const body = `<main data-nav-root>${wrapper("column")}${wrapper("column")}</main>${wrapper("shell")}`;
    const dom = new Window();
    try {
      dom.document.body.innerHTML = body;
      const entries: string[] = [];
      new Function("document", "load", (await renderLoader(body)).replaceAll("import(", "load("))(dom.document, (url: string) => {
        entries.push(url);
      });
      expect(entries).toEqual(["/_ssr/column.js", "/_ssr/column.js", "/_ssr/shell.js"]);
      expect(dom.document.head.querySelectorAll("link")).toHaveLength(0);
    } finally {
      await dom.happyDOM.close();
    }
  });
});
