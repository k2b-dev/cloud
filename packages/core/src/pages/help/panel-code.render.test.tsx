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

test("the Help start lists the app's Code operations and events between the articles and the shortcuts", async () => {
  codeReference.mockResolvedValue(reference);
  const dom = await render(panelUrl("spaces"));
  const section = dom.document.querySelector("[data-help-code]");
  expect(section?.closest("solid-island")).toBeNull();
  // Order on the start: the kind groups, then Code, then the keyboard shortcuts.
  const start = [...dom.document.querySelectorAll("[data-help-group], [data-help-code], [data-help-shortcuts]")];
  expect(
    start.map((element) =>
      element.hasAttribute("data-help-code") ? "code" : element.hasAttribute("data-help-shortcuts") ? "keys" : "group",
    ),
  ).toEqual(["group", "code", "keys"]);
  expect(section?.querySelector("h3")?.textContent).toBe("Use in Code");
  expect(section?.textContent).toContain('import { spaces } from "@sdk";');
  const rows = [...(section?.querySelectorAll("[data-help-code-operations] > li") ?? [])];
  expect(rows.map((row) => row.querySelector("[data-help-code-path]")?.textContent)).toEqual(
    reference.operations.map((operation) => operation.path),
  );
  expect(rows.map((row) => row.querySelector(".k2b-status-badge__label")?.textContent)).toEqual([
    "Automatic",
    "Administrator approves",
    "Never",
  ]);
  expect(rows[0]?.textContent).toContain("List the items of a space.");
  // The groups are closed native disclosures, so a long reference does not push the shortcuts away.
  const groups = [...(section?.querySelectorAll("details") ?? [])];
  expect(groups.map((group) => group.querySelector("summary")?.textContent)).toEqual(["Operations (3)", "Events (1)"]);
  expect(groups.every((group) => !group.open)).toBe(true);
  const event = section?.querySelector("[data-help-code-events] > li");
  expect(event?.textContent).toContain("spaces.item.due");
  expect(event?.textContent).toContain("Subjectspaces.item");
  expect(event?.textContent).toContain("Placespaces.space");
  expect(codeReference).toHaveBeenCalledWith("spaces", expect.objectContaining({ locale: "en" }));
  dom.cleanup();
});

test("the Code section speaks the reader's language", async () => {
  codeReference.mockResolvedValue(reference);
  const dom = await render(panelUrl("spaces"), { headers: { "Accept-Language": "de" } });
  const section = dom.document.querySelector("[data-help-code]");
  expect(section?.querySelector("h3")?.textContent).toBe("In Code nutzen");
  expect(section?.textContent).toContain("Administration gibt frei");
  expect(section?.textContent).toContain("Operationen (3)");
  expect(codeReference).toHaveBeenCalledWith("spaces", expect.objectContaining({ locale: "de" }));
  dom.cleanup();
});

test("an app without Code operations says so, and a failed read offers a reload of the panel", async () => {
  codeReference.mockResolvedValue({ export: null, operations: [], events: [] });
  let dom = await render(panelUrl("spaces"));
  let section = dom.document.querySelector("[data-help-code]");
  expect(section?.textContent).toContain("spaces fixture app has no operations for Code.");
  expect(section?.querySelector("details")).toBeNull();
  expect(section?.textContent).not.toContain("@sdk");
  dom.cleanup();

  codeReference.mockResolvedValue("failed");
  const url = panelUrl("spaces");
  dom = await render(url);
  section = dom.document.querySelector("[data-help-code]");
  expect(section?.querySelector('[role="alert"]')?.textContent).toContain("The Code reference did not load.");
  expect(section?.querySelector("a")?.getAttribute("href")).toBe(url);
  expect(section?.querySelector("a")?.textContent).toBe("Reload");
  dom.cleanup();
});

test("guests and people who cannot write Code see no Code section, and nothing is loaded for them", async () => {
  // The real loader decides; a guest is refused before the catalog or the policy is read.
  codeReference.mockImplementation(realLoadCodeHelpReference);
  const catalog = spyOn(await import("@k2b/cloud/capabilities/server"), "getCapabilityCatalogApp");
  try {
    person.profile = "guest";
    const dom = await render(panelUrl("spaces"));
    expect(dom.document.querySelector("[data-help-code]")).toBeNull();
    expect(dom.document.querySelector("[data-help-shortcuts]")).not.toBeNull();
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
  expect(dom.document.querySelector("[data-help-code]")).toBeNull();
  expect(codeReference).not.toHaveBeenCalledWith("restricted", expect.anything());
  dom.cleanup();
});
