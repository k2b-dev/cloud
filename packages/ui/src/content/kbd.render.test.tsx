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

const { Kbd } = await import("./Kbd");
const { LocaleProvider } = await import("../intl/locale");
const { SpotlightButton } = await import("../actions/SpotlightSearch");

const cap = (platform?: "apple" | "other", locale = "en", keys = "mod+k") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(Kbd, { keys, platform });
      },
    }),
  );

describe("Kbd server rendering", () => {
  test("renders caps and one spoken shortcut in both locales", () => {
    for (const [platform, locale, label, name] of [
      ["apple", "en", "⌘", "Command K"],
      ["apple", "de", "⌘", "Befehlstaste K"],
      ["other", "en", "Ctrl", "Control K"],
      ["other", "de", "Strg", "Steuerung K"],
    ] as const) {
      const html = cap(platform, locale);
      expect(html).toContain('<kbd class="k2b-kbd">');
      expect(html).toContain(`<span class="k2b-sr-only">${name}</span>`);
      expect(html).toContain('<span class="k2b-kbd__keys" aria-hidden="true">');
      expect(html).toContain(`<kbd class="k2b-kbd__key">${label}</kbd>`);
      expect(html).toContain('<kbd class="k2b-kbd__key">K</kbd>');
    }
  });
  test("uses other on the server even when navigator claims Apple", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
    try {
      expect(cap()).toContain(">Ctrl</kbd>");
      expect(cap("apple")).toContain(">⌘</kbd>");
      expect(cap(undefined, "en", "unknown+k")).toBe("");
    } finally {
      if (previous) Object.defineProperty(globalThis, "navigator", previous);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  });
  test("SpotlightButton uses shared caps and preserves literal labels", () => {
    const render = (props: { shortcut?: string; shortcutLabel?: string | false }) =>
      renderToString(() => createComponent(SpotlightButton, { variant: "chip", onClick() {}, ...props }));
    expect(render({ shortcut: "mod+k", shortcutLabel: "Literal" })).toContain('class="k2b-kbd__keys"');
    expect(render({ shortcut: "mod+k", shortcutLabel: "Literal" })).not.toContain("Literal");
    expect(render({ shortcutLabel: "Literal" })).toContain('<kbd class="k2b-kbd"><kbd class="k2b-kbd__key">Literal</kbd></kbd>');
    expect(render({ shortcutLabel: false })).not.toContain("<kbd");
  });
});
