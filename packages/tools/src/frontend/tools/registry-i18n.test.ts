import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { fuzzy } from "@k2b/stdlib";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import type { LocalizedRegistry, LocalizedTool, ToolId } from "./registry";

const root = mkdtempSync(join(tmpdir(), "tools-registry-i18n-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { registryMessages, resolveRegistry } = await import("./registry");
const { default: ToolCatalog, toolCatalogMessages } = await import("../ToolCatalog.island.tsx");
const { toolSearchMessages } = await import("../ToolSearchButton.island.tsx");
const { toolsWorkspaceMessages } = await import("../ToolsWorkspace.tsx");
const { toolsPageMessages } = await import("../page.tsx");
const { LocaleProvider } = await import("@k2b/ui");

const mustTool = (registry: LocalizedRegistry, id: ToolId): LocalizedTool => {
  const tool = registry.toolById(id);
  if (!tool) throw new Error(`tool ${id} is missing from the registry`);
  return tool;
};

describe("Tools i18n catalogs", () => {
  test("German is complete for every catalog", () => {
    for (const catalog of [registryMessages, toolCatalogMessages, toolSearchMessages, toolsWorkspaceMessages, toolsPageMessages]) {
      expect(catalog.locales).toContain("de");
      expect(catalog.check()).toEqual([]);
    }
  });

  test("resolves German registry text", () => {
    const registry = resolveRegistry("de");
    expect(registry.locale).toBe("de");
    expect(mustTool(registry, "password").name).toBe("Passwortgenerator");
    expect(mustTool(registry, "qr").description).toBe("Links, WLAN-Zugänge, Kontakte und Text als QR-Codes ausgeben.");
    expect(registry.categories.security.label).toBe("Sicherheit");
    expect(registry.taskGroups.transform.label).toBe("Umwandeln und schützen");
    expect(toolCatalogMessages.resolve(["de"]).t.emptyTitle).toBe("Kein Werkzeug passt zu dieser Aufgabe");
  });

  test("keeps the English base text", () => {
    const registry = resolveRegistry("en");
    expect(mustTool(registry, "password").name).toBe("Password Generator");
    expect(registry.categories.encoders.label).toBe("Encoders");
    expect(toolCatalogMessages.resolve(["en"]).t.matchingTools({ count: 1 })).toBe("1 matching tool.");
    expect(toolCatalogMessages.resolve(["de"]).t.matchingTools({ count: 2 })).toBe("2 passende Werkzeuge.");
  });

  test("de-CH resolves to de", () => {
    const registry = resolveRegistry("de-CH");
    expect(registry.locale).toBe("de");
    expect(mustTool(registry, "color").name).toBe("Farbkonverter");
    expect(toolSearchMessages.resolve(["de-CH"]).t.noResults).toBe("Keine Werkzeuge gefunden.");
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
    expect(html).toContain(toolCatalogMessages.resolve(["de"]).t.groupedByTask);
    expect(html).toContain(mustTool(resolveRegistry("de"), "password").name);
    expect(html).not.toContain("Quick tools");
  });
});
