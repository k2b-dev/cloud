import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-help-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { TableOfContents } = await import("./TableOfContents");
const { LocaleProvider } = await import("../intl/locale");

test("TableOfContents names the navigation, localizes its title and marks the first item", () => {
  for (const [locale, title] of [
    ["en", "On this page"],
    ["de", "Auf dieser Seite"],
  ]) {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: locale!,
        get children() {
          return createComponent(TableOfContents, {
            items: [
              { id: "one", label: "One" },
              { id: "two", label: "Two" },
            ],
            sticky: true,
          });
        },
      }),
    );
    expect(html).toContain('class="k2b-toc" data-sticky="true"');
    const id = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(id).toMatch(/^k2b-toc-/);
    expect(html).toContain(`id="${id}">${title}</p>`);
    expect(html).toContain('<ol class="k2b-toc__list">');
    expect(html).toContain('href="#one" aria-current="location">One</a>');
    expect(html).toContain('href="#two">Two</a>');
  }
  expect(renderToString(() => createComponent(TableOfContents, { items: [] }))).toBe("");
  expect(renderToString(() => createComponent(TableOfContents, { items: [{ id: "one", label: "One" }], title: "Contents" }))).toContain(
    ">Contents</p>",
  );
});
