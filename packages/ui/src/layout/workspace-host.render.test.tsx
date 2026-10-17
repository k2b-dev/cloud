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
