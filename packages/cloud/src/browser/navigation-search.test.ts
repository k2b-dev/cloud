import { describe, expect, test } from "bun:test";
import { compileAppPresentation } from "../_internal/app-presentation";
import { validateAppRegistryEntry } from "../_internal/registry-validation";
import { buildRuntimeFromRegistry } from "../_internal/runtime-context";
import type { AppMeta } from "../contracts/app";
import { resolveAppPresentation } from "../shared/app-presentation";
import { matchNavigationSearchItems, navigationSearchItems } from "./navigation-search";

const app: AppMeta = {
  id: "utilities",
  name: "Utilities",
  description: "Utilities",
  icon: "ti ti-tools",
  routes: ["/utilities"],
  searchLinks: [
    { label: "Code generator", description: "Create printable barcodes.", href: "/utilities/qr", keywords: ["qr", "scan", "code"] },
  ],
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Werkzeuge",
        searchLinks: { "/utilities/qr": "Code-Generator" },
        searchLinkDescriptions: { "/utilities/qr": "Druckbare Barcodes erstellen." },
      },
      "de-CH": { searchLinks: { "/utilities/qr": "QR-Generator" } },
    },
  },
};

describe("global navigation search", () => {
  test("carries and localizes app-owned links through the registry without creating capabilities", () => {
    const entry = { ...app, baseUrl: "http://utilities:3000", presentation: compileAppPresentation(app, app.presentation) };
    expect(validateAppRegistryEntry(entry)).toBeNull();
    const runtime = buildRuntimeFromRegistry([entry]);
    const localized = resolveAppPresentation(runtime.apps[0]!, "de-CH");
    const items = navigationSearchItems([localized], ["utilities"]);
    expect(matchNavigationSearchItems(items, { query: " QR ", tags: [] })[0]).toMatchObject({
      href: "/utilities/qr",
      title: "QR-Generator",
      preview: "Druckbare Barcodes erstellen.",
      appName: "Werkzeuge",
      priority: 0,
      readable: false,
    });
    expect(runtime.apps[0]?.searchTags).toBeUndefined();
    expect(app.searchLinks?.[0]?.label).toBe("Code generator");
    expect(resolveAppPresentation(runtime.apps[0]!, "fr").searchLinks?.[0]?.label).toBe("Code generator");
    expect(resolveAppPresentation(runtime.apps[0]!, "fr").searchLinks?.[0]?.description).toBe("Create printable barcodes.");
    expect(app.searchLinks?.[0]?.description).toBe("Create printable barcodes.");
    expect(matchNavigationSearchItems(items, { query: "druckbare", tags: [] })).toHaveLength(1);
  });

  test("requires a visible app, matches all words, and respects app, tag and reader filters", () => {
    expect(navigationSearchItems([app], [])).toEqual([]);
    const items = navigationSearchItems([app], [app.id]);
    const match = (input: Parameters<typeof matchNavigationSearchItems>[1]) => matchNavigationSearchItems(items, input);
    expect(match({ query: "scan CODE", tags: [], appId: "utilities" })).toHaveLength(1);
    for (const input of [
      { query: "q", tags: [] },
      { query: "", tags: [] },
      { query: "missing", tags: [] },
      { query: "qr", tags: ["notes"] },
      { query: "qr", tags: [], appId: "notes" },
      { query: "qr", tags: [], requireReader: true },
    ])
      expect(match(input)).toEqual([]);
  });

  test("rejects unsafe links and malformed keywords or translation keys at the registry boundary", () => {
    const entry = { ...app, baseUrl: "http://utilities:3000" };
    for (const href of ["//evil.example", "/\\evil.example", "javascript:alert(1)", "https://evil.example", "/\n/evil.example"]) {
      expect(validateAppRegistryEntry({ ...entry, searchLinks: [{ label: "Bad", href }] })).toContain("searchLinks");
    }
    expect(validateAppRegistryEntry({ ...entry, searchLinks: [{ label: "Bad", href: "/qr", keywords: [42] }] })).toContain("searchLinks");
    expect(validateAppRegistryEntry({ ...entry, searchLinks: [{ label: "Bad", href: "/qr", description: 42 }] })).toContain("searchLinks");
    expect(
      validateAppRegistryEntry({
        ...entry,
        presentation: { baseLocale: "en", translations: { de: { searchLinkDescriptions: { "/qr": 42 } } } },
      }),
    ).toContain("searchLinkDescriptions");
    expect(() => compileAppPresentation(app, { baseLocale: "en", translations: { de: { searchLinks: { "/missing": "Bad" } } } })).toThrow(
      "unknown key",
    );
    expect(() =>
      compileAppPresentation(app, { baseLocale: "en", translations: { de: { searchLinkDescriptions: { "/missing": "Bad" } } } }),
    ).toThrow("unknown key");
  });

  test("keeps label-only links valid without inventing a description", () => {
    const legacy = { ...app, presentation: undefined, searchLinks: [{ label: "Legacy", href: "/utilities/old" }] };
    expect(validateAppRegistryEntry({ ...legacy, baseUrl: "http://utilities:3000" })).toBeNull();
    expect(navigationSearchItems([legacy], [legacy.id])[0]?.preview).toBeUndefined();
  });
});

test("an explicit app context browses static links and keeps fuzzy matching local", () => {
  const items = navigationSearchItems([app], [app.id]);
  expect(matchNavigationSearchItems(items, { query: "", tags: [], appId: app.id })).toHaveLength(1);
  expect(matchNavigationSearchItems(items, { query: "cdgn", tags: [], appId: app.id })).toHaveLength(1);
  expect(matchNavigationSearchItems(items, { query: "cdgn", tags: [] })).toHaveLength(0);
  expect(matchNavigationSearchItems(items, { query: "", tags: [] })).toHaveLength(0);
});

describe("app launcher", () => {
  const launcherApp = {
    ...app,
    nav: { href: "/utilities", section: "more" as const },
    searchLinks: [
      { label: "Tools", href: "/utilities", keywords: ["utilities", "Werkzeug", "Rechner"] },
      ...app.searchLinks!,
      { label: "Duplicate", href: "/utilities/qr" },
    ],
  };
  const match = (query: string) => matchNavigationSearchItems(navigationSearchItems([launcherApp], [app.id]), { query, tags: [] });

  test("automatically opens the localized navigation entry, merging entry aliases and duplicate hrefs", () => {
    const localized = resolveAppPresentation(launcherApp, "de");
    const items = navigationSearchItems([localized], [app.id]);
    expect(matchNavigationSearchItems(items, { query: "code", tags: [] })).toHaveLength(1);
    for (const query of ["Werkzeuge", "utilities", "Tools", "Rechner", "werkzege"]) {
      expect(matchNavigationSearchItems(items, { query, tags: [] })[0]).toMatchObject({
        kind: "app",
        title: "Werkzeuge",
        icon: app.icon,
        href: "/utilities",
        readable: false,
        ref: { type: "cloud.navigation" },
      });
    }
    expect(match("Utilities")[0]?.title).toBe("Utilities");
    expect(navigationSearchItems([launcherApp], [])).toEqual([]);
    expect(navigationSearchItems([{ ...launcherApp, nav: undefined, searchLinks: [] }], [app.id])).toEqual([]);
  });

  test("ranks exact names and aliases before word starts, substrings and conservative whole-name typos", () => {
    const candidates = ["Utilities Plus", "Xutilities", "Utilites", "Utilities"].map((name, index) => ({
      id: `${index}`,
      name,
      icon: app.icon,
      nav: { href: `/apps/${index}` },
      searchLinks: [],
    }));
    const items = navigationSearchItems(
      candidates,
      candidates.map((candidate) => candidate.id),
    );
    const result = matchNavigationSearchItems(items, { query: "utilities", tags: [] });
    expect(result.map((item) => item.title)).toEqual(["Utilities", "Utilities Plus", "Xutilities", "Utilites"]);
    // Extra keywords never add scores; equal matches preserve the authorized catalog order.
    const many = { ...candidates[0]!, searchLinks: [{ label: "Utilities Plus", href: "/apps/0", keywords: Array(50).fill("utilities") }] };
    expect(
      matchNavigationSearchItems(navigationSearchItems([many, candidates[3]!], ["0", "3"]), { query: "utilities", tags: [] }).map(
        (item) => item.appId,
      ),
    ).toEqual(["0", "3"]);
  });

  test("keeps the owning launcher when another app contributes the same href as a page", () => {
    const other = { ...app, id: "other", searchLinks: [{ label: "Utilities page", href: "/utilities" }] };
    const items = navigationSearchItems([other, launcherApp], [other.id, launcherApp.id]);
    const global = matchNavigationSearchItems(items, { query: "utilities", tags: [] });
    expect(global).toHaveLength(1);
    expect(global[0]).toMatchObject({ appId: app.id, kind: "app", title: app.name });
    expect(matchNavigationSearchItems(items, { query: "", tags: [], appId: "other" })[0]).toMatchObject({
      title: "Utilities page",
      kind: undefined,
    });
  });

  test("does not fuzz descriptions, short accidental subsequences or unrelated aliases", () => {
    for (const query of ["utlt", "xxutilitiesxx", "unrelated", "drckbre", "", "u"]) expect(match(query)).toEqual([]);
    // Static pages retain substring search in their full text.
    expect(match("printable")[0]?.href).toBe("/utilities/qr");
    expect(match("utilites")[0]?.href).toBe("/utilities");
  });

  test("keeps launchers out of empty, app, tag and resource-picker searches", () => {
    const items = navigationSearchItems([launcherApp], [app.id]);
    expect(matchNavigationSearchItems(items, { query: "", tags: [] })).toEqual([]);
    expect(matchNavigationSearchItems(items, { query: "", tags: [], appId: app.id }).map((item) => item.href)).toEqual([
      "/utilities",
      "/utilities/qr",
    ]);
    expect(matchNavigationSearchItems(items, { query: "Tools", tags: [], appId: app.id })[0]).toMatchObject({
      kind: undefined,
      title: "Tools",
      href: "/utilities",
    });
    const automaticOnly = navigationSearchItems([{ ...launcherApp, searchLinks: [] }], [app.id]);
    expect(matchNavigationSearchItems(automaticOnly, { query: "", tags: [], appId: app.id })).toEqual([]);
    expect(matchNavigationSearchItems(items, { query: "utilities", tags: ["note"] })).toEqual([]);
    expect(matchNavigationSearchItems(items, { query: "utilities", tags: [], requireReader: true })).toEqual([]);
  });
});
