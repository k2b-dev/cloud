import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fuzzy } from "@k2b/stdlib";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import type { LocalizedRegistry, LocalizedTool, ToolId } from "./registry";

const root = mkdtempSync(join(tmpdir(), "tools-registry-i18n-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { categoryOrder, registryMessages, resolveRegistry } = await import("./registry");
const { default: ToolCatalog, toolCatalogMessages } = await import("../ToolCatalog.island.tsx");
const { toolSearchMessages } = await import("../ToolSearchButton.island.tsx");
const { toolsWorkspaceMessages } = await import("../tools-messages");
const { LocaleProvider } = await import("@k2b/ui");

const mustTool = (registry: LocalizedRegistry, id: ToolId): LocalizedTool => {
  const tool = registry.toolById(id);
  if (!tool) throw new Error(`tool ${id} is missing from the registry`);
  return tool;
};

describe("Tools i18n catalogs", () => {
  test("German is complete for every catalog", () => {
    for (const catalog of [registryMessages, toolCatalogMessages, toolSearchMessages, toolsWorkspaceMessages]) {
      expect(catalog.locales).toContain("de");
      expect(catalog.check()).toEqual([]);
    }
  });

  test("resolves German registry text", () => {
    const registry = resolveRegistry("de");
    expect(registry.locale).toBe("de");
    expect(mustTool(registry, "password").name).toBe("Passwort");
    expect(mustTool(registry, "qr").description).toBe("Links, WLAN-Zugänge, Kontakte und Text als QR-Codes ausgeben.");
    expect(registry.categories.security.label).toBe("Sicherheit");
    expect(registry.categories.text.label).toBe("Text und Codes");
    expect(toolCatalogMessages.resolve(["de"]).t.emptyTitle).toBe(
      "Kein Werkzeug passt zu dieser Aufgabe. Suche nach einem Werkzeug, Format oder Arbeitsschritt.",
    );
  });

  test("keeps the English base text", () => {
    const registry = resolveRegistry("en");
    expect(mustTool(registry, "password").name).toBe("Password");
    expect(registry.categories.documents.label).toBe("Documents");
    expect(toolCatalogMessages.resolve(["en"]).t.matchingTools({ count: 1 })).toBe("1 matching tool");
    expect(toolCatalogMessages.resolve(["de"]).t.matchingTools({ count: 2 })).toBe("2 passende Werkzeuge");
  });

  test("de-CH resolves to de", () => {
    const registry = resolveRegistry("de-CH");
    expect(registry.locale).toBe("de");
    expect(mustTool(registry, "color").name).toBe("Farben");
    expect(toolSearchMessages.resolve(["de-CH"]).t.tools).toBe("Werkzeuge");
  });

  test("search text matches German and English terms", () => {
    const de = resolveRegistry("de");
    const passwordText = de.searchText(mustTool(de, "password"));
    expect(passwordText).toContain("passwortgenerator");
    expect(passwordText).toContain("kennwort");
    expect(passwordText).toContain("memorable");

    // The German search placeholder promises "Bild skalieren"; the English one "resize image".
    const germanHits = fuzzy.filter("bild skalieren", de.tools, { key: de.searchText }).map((hit) => hit.item.id);
    expect(germanHits).toContain("image");
    const en = resolveRegistry("en");
    const englishHits = fuzzy.filter("resize image", en.tools, { key: en.searchText }).map((hit) => hit.item.id);
    expect(englishHits).toContain("image");
  });

  test("catalog shares five ordered categories and exactly four shortcuts", () => {
    const registry = resolveRegistry("de");
    expect(categoryOrder.map((category) => registry.categories[category].label)).toEqual([
      "Bilder",
      "Dokumente",
      "Text und Codes",
      "Sicherheit",
      "Netzwerk",
    ]);
    expect(
      registry.tools
        .filter((tool) => tool.featured)
        .map((tool) => tool.id)
        .sort(),
    ).toEqual(["image", "password", "qr", "speedtest"]);
    expect(registry.tools.filter((tool) => tool.category === "documents").map((tool) => tool.id)).toEqual([
      "document-markdown",
      "markdown-pdf",
    ]);
    expect(
      registry.tools
        .filter((tool) => tool.category === "images")
        .map((tool) => tool.id)
        .sort(),
    ).toEqual(["image", "image-converter"]);
    const html = renderToString(() => createComponent(ToolCatalog, {}));
    const sections = [...html.matchAll(/data-k2-part="Section" aria-label="([^"]+)"/g)].map((match) => match[1]);
    const english = resolveRegistry("en");
    expect(sections).toEqual([
      toolCatalogMessages.resolve(["en"]).t.quickTools,
      ...categoryOrder.map((category) => english.categories[category].label),
    ]);
    // the tools used often are tiles: four of them
    expect(html.match(/data-k2-part="Tiles"[\s\S]*?<\/[a-z]+>/)).not.toBeNull();
    expect([...html.matchAll(/href="\/tools\/(image|qr|password|speedtest)"/g)].length).toBeGreaterThanOrEqual(8);
  });

  test("SSR search starts with the requested query and offers recovery for no results", () => {
    const hits = renderToString(() => createComponent(ToolCatalog, { search: "sha256" }));
    expect(hits).toContain('value="sha256"');
    expect(hits).toContain("Checksum");
    expect(hits).not.toContain('aria-label="Used often"');
    const empty = renderToString(() => createComponent(ToolCatalog, { search: "zzzzzzzzzzzzzzzzzzzzzzzzzzzz" }));
    expect(empty).toContain("No tool matches this task");
    expect(empty).toContain("Clear search");
    expect(empty).not.toContain('data-k2-part="List"');
  });

  test("SSR render under LocaleProvider matches the direct German resolve", () => {
    const html = renderToString(
      (): JSX.Element =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(ToolCatalog, {});
          },
        }),
    );
    expect(html).toContain(toolCatalogMessages.resolve(["de"]).t.quickTools);
    expect(html).toContain(toolCatalogMessages.resolve(["de"]).t.allTools({ count: 15 }));
    expect(html).toContain(mustTool(resolveRegistry("de"), "password").name);
    expect(html).not.toContain("Used often");
  });
});
