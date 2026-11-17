import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "accounts-tab-toolbar-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { LocaleProvider } = await import("@k2b/ui");
const { default: TabToolbar } = await import("./TabToolbar");

for (const locale of ["en", "de"]) {
  test(`service accounts filter is a localized toggle link (${locale})`, () => {
    const href = "/app/accounts/groups/finance?tab=members&service_accounts=true&search=ada";
    for (const active of [true, false]) {
      const html = renderToString(() =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(TabToolbar, {
              searchAction: "/app/accounts/groups/finance",
              serviceAccountsToggleUrl: href,
              showServiceAccounts: active,
            });
          },
        }),
      );
      const link = html.match(/<a\b[^>]*class="k2b-filter-chip[^>]*>[\s\S]*?<\/a>/)?.[0];
      expect(link).toBeDefined();
      expect(link).toContain(`href="${href.replaceAll("&", "&amp;")}"`);
      expect(link).toContain(locale === "de" ? "Agenten" : "Agents");
      expect(link!.includes('data-active="true"')).toBe(active);
      expect(link!.includes('aria-current="true"')).toBe(active);
      expect(link).not.toContain('data-variant="primary"');
      expect(link).not.toContain("aria-pressed");
      if (!active) {
        expect(link).not.toContain("data-active=");
        expect(link).not.toContain("aria-current=");
      }
    }
  });
}
