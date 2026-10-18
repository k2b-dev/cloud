import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const directory = mkdtempSync(resolve(tmpdir(), "k2b-workspace-host-render-"));
const { plugin } = createConfig({ dev: true, rootDir: directory });
Bun.plugin(plugin());
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const { default: AppWorkspace } = await import("./AppWorkspace");
const { LocaleProvider } = await import("../intl/locale");

for (const locale of ["en", "de"] as const) {
  test(`Detail server-renders an accessible Details toggle before its handle and aside (${locale})`, () => {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(AppWorkspace.Detail, { id: "person", open: true, children: "Contact" });
        },
      }),
    );
    const button = html.match(/<button[^>]*data-app-workspace-detail-toggle[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-controls="k2b-workspace-detail-person"');
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain('aria-hidden="true"');
    expect(button).toContain("Details");
    expect(html.indexOf(button!)).toBeLessThan(html.indexOf('data-app-workspace-resize="detail"'));
    expect(html.indexOf('data-app-workspace-resize="detail"')).toBeLessThan(html.indexOf("<aside"));
  });
}

for (const openOnChoice of [undefined, true, false]) {
  test(`Detail renders request-only choice metadata only when opted out (${openOnChoice})`, () => {
    const html = renderToString(() =>
      createComponent(AppWorkspace.Detail, { id: "reader", open: true, openOnChoice, children: "Context" }),
    );
    if (openOnChoice === false) expect(html).toMatch(/<aside[^>]*data-workspace-detail-choice="request"/);
    else expect(html).not.toContain("data-workspace-detail-choice");
  });
}

for (const minWidth of [760, 320, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  test(`Main emits its scoped minimum rule only for finite widths above 320 (${minWidth})`, () => {
    const html = renderToString(() => createComponent(AppWorkspace.Main, { minWidth, children: "Main" }));
    if (minWidth === 760) {
      expect(html).toContain('data-workspace-main-min="760"');
      expect(html).toContain("--k2b-workspace-main-min:760px");
      expect(html).toContain(".k2b-app-workspace:has(> .k2b-app-workspace__content > .k2b-app-workspace__main");
      expect(html).toContain(":is(solid-island, solid-client)");
    } else {
      expect(html).not.toContain("data-workspace-main-min");
      expect(html).not.toContain("<style");
    }
  });
}
