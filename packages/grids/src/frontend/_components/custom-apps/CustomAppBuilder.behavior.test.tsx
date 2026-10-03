import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicCustomApp } from "../workspace/workspace-public-state-model";
import type { CustomAppCatalog } from "./custom-app-catalog";

const domTest = isServer ? test.skip : test;

// The first import runs the Solid DOM transform over the builder's whole source graph, which can take longer than the
// 5 s test timeout on a busy machine. Load it once, outside any test, so the timeout measures behavior.
// The @k2b/ui browser build needs a document while its modules evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { CustomAppBuilder: (await import("./CustomAppBuilder")).default, prompts: (await import("@k2b/ui")).prompts };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

type Definition = NonNullable<PublicCustomApp["draftDefinition"]>;

const definition = (markdown: string): Definition => ({
  schemaVersion: 5,
  kind: "grids.custom-app",
  id: "APP001",
  baseId: "BASE01",
  name: "Requests",
  startPageId: "home",
  pages: [
    {
      id: "home",
      title: "Home",
      navigation: { visible: true },
      parameters: {},
      rows: [
        {
          id: "main",
          columns: [{ id: "main", span: 12, blocks: [{ id: "intro", type: "markdown", markdown }] }],
        },
      ],
    },
  ],
});

const capabilities: NonNullable<PublicCustomApp["draftCapabilities"]> = {
  availability: [],
  views: [],
  insights: [],
  recordQueries: [],
  records: [],
  forms: [],
  comments: [],
  documents: [],
  workflowLaunchers: [],
  scannerLaunchers: [],
};

const catalog: CustomAppCatalog = {
  customApps: [],
  workflows: [],
  workflowLaunchers: [],
  workflowLevels: {},
  tables: [],
  tableLevels: {},
  fieldsByTable: {},
  viewsByTable: {},
  formsByTable: {},
  documentTemplatesByTable: {},
  documentTemplateLevels: {},
  sidebarForms: [],
  sidebarDocumentTemplates: [],
};

const live = definition("Send a request");
const app: PublicCustomApp = {
  id: "APP001",
  baseId: "BASE01",
  name: "Requests",
  icon: null,
  draftDefinition: definition("Send a request today"),
  draftDiagnostics: [],
  draftCapabilities: capabilities,
  publishedDefinition: live,
  publishedDiagnostics: [],
  publishedCapabilities: capabilities,
  publishedAt: "2026-08-11T10:00:00.000Z",
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-11T10:00:00.000Z",
  draftValid: true,
  publishedValid: true,
  hasUnpublishedChanges: true,
  dependenciesChanged: false,
};

const brokenByResource = "The Form is missing, inactive, or belongs to another Base.";

domTest("restoring a live version that no longer compiles keeps Publish disabled and names the cause", async () => {
  const dom = createDomTestHarness();
  const { CustomAppBuilder, prompts } = modules!;
  // A used resource changed incompatibly after publication: the restored draft equals the live version but is invalid.
  const restored: PublicCustomApp = {
    ...app,
    draftDefinition: live,
    draftDiagnostics: [{ path: ["pages", "home", "blocks", "intro"], message: brokenByResource }],
    draftCapabilities: null,
    draftValid: false,
    hasUnpublishedChanges: false,
    dependenciesChanged: true,
  };
  const requests: string[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(`${init?.method ?? "GET"} ${new URL(url, "http://localhost").pathname}`);
        return url.endsWith("/apps/APP001/restore") ? Response.json(restored) : Response.json({ message: "Unexpected" }, { status: 500 });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
  const success = spyOn(prompts, "success").mockResolvedValue(undefined);
  delegateEvents(["click"]);
  const dispose = render(() => createComponent(CustomAppBuilder, { app, baseId: "BASE01", catalog, editMode: true }), dom.root);
  const button = (label: string) =>
    [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
  try {
    expect(dom.root.textContent).toContain("Changes are in a draft");
    expect(button("Publish changes")?.disabled).toBe(false);
    expect(button("Review draft")).toBeUndefined();

    button("Restore live version")!.click();
    await Bun.sleep(50);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(requests).toEqual(["POST /api/grids/apps/APP001/restore"]);
    expect(dom.root.textContent).toContain("Used resources changed");
    expect(dom.root.textContent).toContain("The saved draft must be fixed before it can be published.");
    expect(button("Restore live version")).toBeUndefined();
    expect(button("Publish changes")?.disabled).toBe(true);

    button("Review draft")!.click();
    await Bun.sleep(50);
    expect(dom.document.body.textContent).toContain(brokenByResource);
    expect(dom.document.body.textContent).not.toContain("No detailed diagnostics are available.");
  } finally {
    dispose();
    fetchMock.mockRestore();
    confirm.mockRestore();
    success.mockRestore();
    dom.cleanup();
  }
});
