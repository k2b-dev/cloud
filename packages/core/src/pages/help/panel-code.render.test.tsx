import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { CodeHelpReference } from "../../code/help-reference";
import {
  codeReference,
  defaultRailPreferences,
  help,
  panelUrl,
  person,
  rail,
  realLoadCodeHelpReference,
  server,
  settings,
  snapshot,
} from "./panel.test-fixture";

const reference: CodeHelpReference = {
  export: "spaces",
  operations: [
    { path: "spaces.space(id).item.list", kind: "query", policy: "automatic", description: "List the items of a space." },
    { path: "spaces.space(id).item.create", kind: "action", policy: "admin", description: "Create an item." },
    { path: "spaces.space(id).delete", kind: "action", policy: "never", description: "Delete a space." },
  ],
  events: [{ type: "spaces.item.due", subject: "spaces.item", place: "spaces.space", description: "An item is due." }],
};
const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  spies.push(
    spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(snapshot, "loadSnapshot").mockResolvedValue({ app: { name: "Cloud" } }),
    spyOn(help, "createHelpReader").mockImplementation((locale) => ({
      manifest: async (id) => ({
        manifestHash: id,
        pageBase: `/help/apps/${id}`,
        baseLocale: "en",
        locale,
        documents: [
          { id: `${id}-roles`, title: `${id} roles`, order: 1, locale, kind: "reference", url: `/api/help/${id}`, searchUrl: "/s" },
        ],
      }),
      list: async () => [],
      search: async () => [],
      read: async () => null,
    })),
  );
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  codeReference.mockClear();
  codeReference.mockResolvedValue(null);
  person.profile = "user";
});
const render = async (path: string, init?: RequestInit) => {
  const dom = createDomTestHarness();
  dom.document.body.innerHTML = await (await server.request(path, init)).text();
  return dom;
};

const codeSection = (dom: ReturnType<typeof createDomTestHarness>, title = "Use in Code") =>
  dom.document.querySelector(`section[data-k2-part="Section"][aria-label="${title}"]`);

test("the Help start lists the app's Code operations and events between the articles and the shortcuts", async () => {
  codeReference.mockResolvedValue(reference);
  const dom = await render(panelUrl("spaces"));
  const section = codeSection(dom);
  // Order on the start: the kind groups, then Code, then the keyboard shortcuts.
  const titles = [...dom.document.querySelectorAll('section[data-k2-part="Section"]')].map((element) => element.getAttribute("aria-label"));
  expect(titles.indexOf("Look up")).toBeLessThan(titles.indexOf("Use in Code"));
  expect(titles.indexOf("Use in Code")).toBeLessThan(titles.indexOf("Everywhere"));
  expect(section?.textContent).toContain('import { spaces } from "@sdk";');
  // The groups start folded, so a long reference does not push the shortcuts away.
  const groups = [...(section?.querySelectorAll('[data-k2-part="Group"]') ?? [])];
  expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["Operations", "Events"]);
  expect(groups.every((group) => group.hasAttribute("data-folded"))).toBe(true);
  expect(groups.map((group) => group.textContent)).toEqual([expect.stringContaining("3"), expect.stringContaining("1")]);
  expect(codeReference).toHaveBeenCalledWith("spaces", expect.objectContaining({ locale: "en" }));
  dom.cleanup();
});

test("the Code section maps each operation's policy and each event's subject and place", async () => {
  const { codeHelpStartSection } = await import("./CodeHelpSection");
  const data = codeHelpStartSection(reference, "Spaces", "/panel", "en");
  expect(data.groups?.[0]?.rows.map((row) => [row.title, row.state?.label, row.state?.tone])).toEqual(
    reference.operations.map((operation, index) => [
      operation.path,
      ["Automatic", "Administrator approves", "Never"][index],
      ["ok", undefined, "bad"][index],
    ]),
  );
  expect(data.groups?.[0]?.rows[0]?.text).toBe("List the items of a space.");
  expect(data.groups?.[1]?.rows[0]?.title).toBe("spaces.item.due");
  expect(data.groups?.[1]?.rows[0]?.meta).toContain("Subject spaces.item");
  expect(data.groups?.[1]?.rows[0]?.meta).toContain("Place spaces.space");
});

test("the Code section speaks the reader's language", async () => {
  codeReference.mockResolvedValue(reference);
  const dom = await render(panelUrl("spaces"), { headers: { "Accept-Language": "de" } });
  const section = codeSection(dom, "In Code nutzen");
  expect(section).not.toBeNull();
  expect(section?.querySelector('[data-k2-part="Group"]')?.getAttribute("aria-label")).toBe("Operationen");
  expect(codeReference).toHaveBeenCalledWith("spaces", expect.objectContaining({ locale: "de" }));
  dom.cleanup();
});

test("an app without Code operations says so, and a failed read offers a reload of the panel", async () => {
  codeReference.mockResolvedValue({ export: null, operations: [], events: [] });
  let dom = await render(panelUrl("spaces"));
  let section = codeSection(dom);
  expect(section?.textContent).toContain("spaces fixture app has no operations for Code.");
  expect(section?.querySelector('[data-k2-part="Group"]')).toBeNull();
  expect(section?.textContent).not.toContain("@sdk");
  dom.cleanup();

  codeReference.mockResolvedValue("failed");
  const url = panelUrl("spaces");
  dom = await render(url);
  section = codeSection(dom);
  expect(section?.querySelector('[role="alert"]')?.textContent).toContain("The Code reference did not load.");
  const reload = [...(section?.querySelectorAll("a") ?? [])].find((link) => link.textContent?.includes("Reload"));
  expect(reload?.getAttribute("href")).toBe(url);
  dom.cleanup();
});

test("guests and people who cannot write Code see no Code section, and nothing is loaded for them", async () => {
  // The real loader decides; a guest is refused before the catalog or the policy is read.
  codeReference.mockImplementation(realLoadCodeHelpReference);
  const catalog = spyOn(await import("@k2b/cloud/capabilities/server"), "getCapabilityCatalogApp");
  try {
    person.profile = "guest";
    const dom = await render(panelUrl("spaces"));
    expect(codeSection(dom)).toBeNull();
    expect(dom.document.querySelector('section[aria-label="Everywhere"]')).not.toBeNull();
    expect(codeReference).toHaveBeenCalledTimes(1);
    expect(catalog).not.toHaveBeenCalled();
    dom.cleanup();
  } finally {
    catalog.mockRestore();
  }
});

test("Help the reader may not see shows no Code section", async () => {
  codeReference.mockResolvedValue(reference);
  const dom = await render(panelUrl("restricted"));
  expect(codeSection(dom)).toBeNull();
  expect(codeReference).not.toHaveBeenCalledWith("restricted", expect.anything());
  dom.cleanup();
});
