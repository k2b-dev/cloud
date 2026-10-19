import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "gateway-ops-app-icon-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { AppIcon } = await import("./AppIcon");
const render = (accent: string | undefined) => renderToString(() => createComponent(AppIcon, { icon: "ti ti-apps", accent }));

test("app icons use scoped, contrast-checked app ink", () => {
  const html = render("#0f766e");
  const classes = /class="([^"]*)"/.exec(html)![1]!.split(/\s+/);
  expect(classes).toContain("k2b-icon-tile");
  expect(classes).toContain("app-accent-scope");
  expect(classes).toContain("app-accent-text");
  expect(html).toContain("--app-accent:#0f766e");
});

test("missing and invalid app accents use neutral ink without a style", () => {
  for (const accent of [undefined, "red", "#gggggg", "#0f766e;background:red"]) {
    const html = render(accent);
    expect(html).toContain("k2b-icon-tile");
    expect(html).toContain("text-secondary");
    expect(html).not.toContain("app-accent-scope");
    // The SSR renderer emits style="" for an undefined style prop.
    expect(/style="([^"]*)"/.exec(html)?.[1] ?? "").toBe("");
  }
});

test("gateway overview uses semantic metadata ink and the shared app icon component", () => {
  const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  expect(source).not.toMatch(/text-zinc-[3-6]00/);
  expect(source).not.toContain("APP_ICON_CLASSES");
});
