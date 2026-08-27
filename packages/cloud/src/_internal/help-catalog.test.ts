import { describe, expect, test } from "bun:test";
import type { AppRegistryEntry, HelpRegistryEntry } from "../contracts/registry";
import {
  createHelpCatalog,
  helpResourceUri,
  loadCurrentHelp,
  parseHelpResourceUri,
  readHelpCatalog,
  resolveAppHelp,
  searchHelpCatalog,
} from "./help-catalog";

const help: HelpRegistryEntry = {
  appId: "inventory",
  appName: "Inventory",
  appIcon: "ti ti-box",
  manifestHash: "current",
  documents: [
    {
      id: "permissions",
      title: "Permissions",
      description: "Share inventory safely.",
      order: 10,
      markdown: `# Permissions\n\n${"Background. ".repeat(700)}\n\n## Member access\n\nEditors can update inventory.`,
      searchText: "inventory member permissions editors",
    },
  ],
};

const app = (manifestHash = "current"): AppRegistryEntry => ({
  id: "inventory",
  name: "Inventory",
  description: "Inventory app",
  icon: "ti ti-box",
  baseUrl: "http://inventory:3000",
  routes: [],
  help: { manifestHash, pageBase: "/app/inventory/help", documents: [] },
});

describe("live Help catalog", () => {
  test("fails stale app and corpus pairs closed", async () => {
    expect(await loadCurrentHelp({ listApps: async () => [app()], listHelp: async () => [help] })).toEqual([help]);
    expect(await loadCurrentHelp({ listApps: async () => [app("next")], listHelp: async () => [help] })).toEqual([]);
    expect(await resolveAppHelp("inventory", { getApp: async () => app("next"), getHelp: async () => help })).toEqual({
      status: "stale",
    });
  });

  test("shares ranked search and bounded relevant reads", () => {
    const catalog = createHelpCatalog([help]);
    expect(searchHelpCatalog(catalog, { query: "inventory permissions" })).toMatchObject([
      { appId: "inventory", documentId: "permissions" },
    ]);
    const document = readHelpCatalog(catalog, { appId: "inventory", documentId: "permissions", query: "member access" });
    if (!document) throw new Error("Help document missing");
    expect(document.markdown.slice(7_000)).toBe("");
    expect(document).toMatchObject({ truncated: true, markdown: expect.stringContaining("Editors can update inventory") });
  });

  test("normalizes punctuation in agent search terms", () => {
    const catalog = createHelpCatalog([help]);
    expect(searchHelpCatalog(catalog, { query: "inventory-permissions?" })).toMatchObject([
      { appId: "inventory", documentId: "permissions" },
    ]);
  });

  test("resolves each document through exact locale, ancestors, and base", () => {
    const localized: HelpRegistryEntry = {
      ...help,
      baseLocale: "en",
      documents: [...help.documents, { id: "overview", title: "Overview", order: 20, markdown: "English overview" }],
      documentsByLocale: {
        de: [{ ...help.documents[0]!, title: "Berechtigungen", markdown: "Deutscher Inhalt" }],
        "de-CH": [{ id: "overview", title: "Übersicht CH", order: 20, markdown: "Schweizer Inhalt" }],
      },
    };
    const catalog = createHelpCatalog([localized], "de-CH");

    expect(catalog.map(({ documentId, title, locale }) => ({ documentId, title, locale }))).toEqual([
      { documentId: "permissions", title: "Berechtigungen", locale: "de-CH" },
      { documentId: "overview", title: "Übersicht CH", locale: "de-CH" },
    ]);
  });

  test("round-trips stable Help resource URIs", () => {
    const uri = helpResourceUri("inventory", "getting started");
    expect(uri).toBe("cloud://help/inventory/getting%20started");
    expect(parseHelpResourceUri(uri)).toEqual({ appId: "inventory", documentId: "getting started" });
    expect(parseHelpResourceUri("https://example.com/help")).toBeNull();
  });
});
