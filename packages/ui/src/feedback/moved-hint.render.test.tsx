import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-moved-hint-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { MovedHint } = await import("./MovedHint");
const { LocaleProvider } = await import("../intl/locale");

const hint = (open: boolean) =>
  createComponent(MovedHint, {
    open,
    onDismiss: () => {},
    target: () => undefined,
    action: { label: "Show filters", href: "/files?filters=1" },
    children: "Tags moved to the filters.",
  });

test("a closed moved hint emits no markup on the server", () => {
  expect(renderToString(() => hint(false))).not.toContain("k2b-moved-hint");
});

test("an open moved hint renders an anchored manual popover with native link and localized dismissal", () => {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return hint(true);
      },
    }),
  );
  expect(html).toContain('popover="manual"');
  expect(html).toContain('role="group"');
  expect(html).toContain('data-placement="bottom"');
  expect(html).toContain('href="/files?filters=1"');
  expect(html).toContain("Tags moved to the filters.");
  expect(html).toContain("Verstanden");
  const textId = html.match(/aria-labelledby="([^"]+)"/)?.[1];
  expect(textId).toBeDefined();
  expect(html).toContain(`id="${textId}"`);
  expect(html).not.toContain('role="dialog"');
});
