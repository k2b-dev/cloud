import { describe, expect, test } from "bun:test";
import { compileHelp } from "../_internal/help";
import type { AppRegistryEntry, HelpRegistryEntry } from "../contracts/registry";
import { defineHelp } from "../server/help";
import { createHelpRoutes } from "./help";

const source = `---
id: getting-started
title: Getting started
description: Create the first item.
order: 10
---

# Getting started

## Create an item {icon="plus"}

Open the catalog and create an adapter.`;

const compiled = compileHelp({
  appId: "inventory",
  appName: "Inventory",
  appIcon: "ti ti-package",
  basePath: "/app/inventory",
  definition: defineHelp({ documents: [source] }),
});

const app: AppRegistryEntry = {
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-package",
  description: "Inventory app",
  baseUrl: "http://app-inventory:3000",
  routes: ["/app/inventory"],
  help: compiled.summary,
};

const authenticate = async (_c: unknown, next: () => Promise<void>) => next();

describe("Help API", () => {
  test("mounts public Help before authenticated capability middleware", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text();
    expect(source.indexOf('.route("/", helpRoutes)')).toBeLessThan(source.indexOf('.route("/", capabilityRoutes)'));
  });

  test("searches and renders one live matching corpus", async () => {
    const legacyHelp: HelpRegistryEntry = {
      ...compiled.registryEntry,
      documents: compiled.registryEntry.documents.map((document) => ({
        id: document.id,
        title: document.title,
        icon: document.icon,
        description: document.description,
        order: document.order,
        markdown: document.markdown,
      })),
    };
    const routes = createHelpRoutes({
      getApp: async () => app,
      getHelp: async () => legacyHelp,
      authenticate,
    });

    const search = await routes.request("/help/v1/inventory/search?q=adapter");
    expect(search.status).toBe(200);
    expect(await search.json()).toEqual({ locale: "en", ids: ["getting-started"] });

    const document = await routes.request("/help/v1/inventory/documents/getting-started");
    expect(document.status).toBe(200);
    expect(await document.json()).toMatchObject({
      locale: "en",
      id: "getting-started",
      title: "Getting started",
      markdown: expect.stringContaining("Create an item"),
      html: expect.stringContaining("<h2"),
    });
  });

  test("uses the registered search text and renders once per manifest", async () => {
    let currentApp = app;
    let currentHelp: HelpRegistryEntry = {
      ...compiled.registryEntry,
      documents: compiled.registryEntry.documents.map((document) => ({ ...document, searchText: "indexed alias" })),
    };
    let renderCount = 0;
    const routes = createHelpRoutes({
      getApp: async () => currentApp,
      getHelp: async () => currentHelp,
      authenticate,
      renderMarkdown: (markdown) => {
        renderCount += 1;
        return `<p>${markdown.length}</p>`;
      },
    });

    expect(await (await routes.request("/help/v1/inventory/search?q=indexed%20alias")).json()).toEqual({
      locale: "en",
      ids: ["getting-started"],
    });
    expect((await routes.request("/help/v1/inventory/documents/getting-started")).status).toBe(200);
    expect((await routes.request("/help/v1/inventory/documents/getting-started")).status).toBe(200);
    expect(renderCount).toBe(1);

    currentHelp = { ...currentHelp, manifestHash: "next-manifest" };
    currentApp = { ...currentApp, help: { ...currentApp.help!, manifestHash: "next-manifest" } };
    expect((await routes.request("/help/v1/inventory/documents/getting-started")).status).toBe(200);
    expect(renderCount).toBe(2);
  });

  test("uses the request locale for localized search, reads, and render caches", async () => {
    const localized = compileHelp({
      appId: "inventory",
      appName: "Inventory",
      appIcon: "ti ti-package",
      definition: defineHelp({
        baseLocale: "en",
        documents: {
          en: [source],
          de: [source.replace("Getting started", "Erste Schritte").replace("Create the first item.", "Ersten Eintrag anlegen.")],
        },
      }),
    });
    const localizedApp = { ...app, help: localized.summary };
    let renderCount = 0;
    const routes = createHelpRoutes({
      getApp: async () => localizedApp,
      getHelp: async () => localized.registryEntry,
      authenticate,
      renderMarkdown: (markdown) => {
        renderCount += 1;
        return markdown;
      },
    });

    const deHeaders = { "x-cloud-locale": "de-CH" };
    const search = await routes.request("/help/v1/inventory/search?q=ersten", { headers: deHeaders });
    expect(await search.json()).toEqual({ locale: "de", ids: ["getting-started"] });
    const de = await routes.request("/help/v1/inventory/documents/getting-started", { headers: deHeaders });
    expect(await de.json()).toMatchObject({ locale: "de", title: "Erste Schritte" });
    const en = await routes.request("/help/v1/inventory/documents/getting-started", { headers: { "x-cloud-locale": "en" } });
    expect(await en.json()).toMatchObject({ locale: "en", title: "Getting started" });
    expect(renderCount).toBe(2);
  });

  test("rejects missing, mismatched, and unknown Help", async () => {
    const missing = createHelpRoutes({ getApp: async () => null, getHelp: async () => null, authenticate });
    expect((await missing.request("/help/v1/missing/search?q=test")).status).toBe(404);

    const stale = createHelpRoutes({
      getApp: async () => ({ ...app, help: { ...compiled.summary, manifestHash: "stale" } }),
      getHelp: async () => compiled.registryEntry,
      authenticate,
    });
    expect((await stale.request("/help/v1/inventory/search?q=test")).status).toBe(503);

    const routes = createHelpRoutes({ getApp: async () => app, getHelp: async () => compiled.registryEntry, authenticate });
    expect((await routes.request("/help/v1/inventory/documents/missing")).status).toBe(404);
  });
});
