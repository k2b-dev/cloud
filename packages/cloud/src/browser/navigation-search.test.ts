import { describe, expect, test } from "bun:test";
import type { AppMeta } from "../contracts/app";
import { compileAppPresentation } from "../_internal/app-presentation";
import { buildRuntimeFromRegistry } from "../_internal/runtime-context";
import { validateAppRegistryEntry } from "../_internal/registry-validation";
import { resolveAppPresentation } from "../shared/app-presentation";
import { matchNavigationSearchItems, navigationSearchItems } from "./navigation-search";

const app: AppMeta = {
  id: "utilities",
  name: "Utilities",
  description: "Utilities",
  icon: "ti ti-tools",
  routes: ["/utilities"],
  searchLinks: [{ label: "Code generator", href: "/utilities/qr", keywords: ["qr", "scan", "code"] }],
  presentation: { baseLocale: "en", translations: { de: { name: "Werkzeuge", searchLinks: { "/utilities/qr": "Code-Generator" } } } },
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
      title: "Code-Generator",
      appName: "Werkzeuge",
      priority: 0,
      readable: false,
    });
    expect(runtime.apps[0]?.searchTags).toBeUndefined();
    expect(app.searchLinks?.[0]?.label).toBe("Code generator");
    expect(resolveAppPresentation(runtime.apps[0]!, "fr").searchLinks?.[0]?.label).toBe("Code generator");
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
    expect(() => compileAppPresentation(app, { baseLocale: "en", translations: { de: { searchLinks: { "/missing": "Bad" } } } })).toThrow(
      "unknown key",
    );
  });
});
