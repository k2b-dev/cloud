import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "cloud-cache-notice-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: CacheNotice } = await import("./CacheNotice.island.tsx");
test("cache notices explain their own scope in the inherited locale", () => {
  for (const locale of ["en", "de"])
    for (const area of ["settings", "announcements"] as const) {
      const html = renderToString(() =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(CacheNotice, { area });
          },
        }),
      );
      expect(html).toContain(locale === "de" ? "fünf Minuten" : "five minutes");
      expect(html).toContain(locale === "de" ? "Cache leeren" : "Clear cache");
      expect(html).toContain("<button");
      expect(html).not.toContain(locale === "de" ? "Cache zurückgesetzt." : "Cache invalidated.");
    }
});
