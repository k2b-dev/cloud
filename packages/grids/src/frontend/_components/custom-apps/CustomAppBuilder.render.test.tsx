import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PublicCustomApp } from "../workspace/workspace-public-state-model";
import type { CustomAppCatalog } from "./custom-app-catalog";
import "../ssr-test-plugin";

const {
  default: CustomAppBuilder,
  blankCustomAppDefinition,
  customAppStarterGqlSources,
  isCustomAppAvailabilityDiagnostic,
  isCustomAppBlockSourceDiagnostic,
} = await import("./CustomAppBuilder");
const { customAppContextKeys } = await import("../../../custom-apps/context-keys");
const { default: CustomAppBlockPreview } = await import("./CustomAppBlockPreview");
const { CustomAppAvailabilitySection } = await import("./CustomAppGqlField");
const { CustomAppMarkdownField } = await import("./CustomAppMarkdownField");
const { CustomAppChartEditor } = await import("./CustomAppChartEditor");
const { CustomAppHtmlEditor } = await import("./CustomAppHtmlEditor");
const { CustomAppSettings } = await import("./CustomAppSettings");
const { LocaleProvider } = await import("@k2b/ui");
const { CustomAppLifecycleActions } = await import("./CustomAppBuilder");

const app = (): PublicCustomApp => {
  const draftDefinition: NonNullable<PublicCustomApp["draftDefinition"]> = {
    schemaVersion: 5 as const,
    kind: "grids.custom-app",
    id: "APP001",
    baseId: "BASE01",
    name: "Loan desk",
    icon: "clipboard",
    startPageId: "overview",
    pages: [
      {
        id: "overview",
        title: "Overview",
        navigation: { visible: true },
        parameters: {},
        availableWhen: { query: "from table Loans\nwhere created_by = @auth.id\nlimit 1" },
        rows: [
          {
            id: "summary-row",
            columns: [
              {
                id: "summary-column",
                span: 12,
                blocks: [{ id: "intro", type: "markdown", title: "Welcome", markdown: "Choose a request." }],
              },
            ],
          },
        ],
      },
    ],
  };
  return {
    id: "APP001",
    baseId: "BASE01",
    name: "Loan desk",
    icon: "clipboard",
    draftDefinition,
    draftDiagnostics: [],
    draftCapabilities: {
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
    },
    publishedDefinition: null,
    publishedDiagnostics: [],
    publishedCapabilities: null,
    publishedAt: null,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    draftValid: true,
    publishedValid: false,
    hasUnpublishedChanges: true,
  };
};

const catalog = (): CustomAppCatalog => ({
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
});

const catalogWithAuthoringResources = (): CustomAppCatalog => {
  const next = catalog();
  const tableId = "TABLE1";
  const fieldId = "FIELD1";
  next.tables = [
    {
      id: tableId,
      baseId: app().baseId,
      kind: "stored",
      name: "Items",
      description: null,
      icon: "ti ti-box",
      columns: [],
      displayConfig: { mode: "table" },
      auditPolicy: {},
      mutationPolicy: { mode: "all" },
      position: 0,
      disableDirectInsert: false,
      deletedAt: null,
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    },
  ];
  next.fieldsByTable = {
    [tableId]: [
      {
        id: fieldId,
        tableId,
        name: "Name",
        description: null,
        icon: "ti ti-tag",
        type: "text",
        config: {},
        position: 0,
        required: false,
        presentable: true,
        hideInTable: false,
        defaultValue: null,
        indexed: false,
        uniqueConstraint: false,
        deletedAt: null,
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z",
      },
    ],
  };
  next.viewsByTable = {
    [tableId]: [
      {
        id: "VIEW01",
        tableId,
        name: "Available items",
        description: null,
        icon: "ti ti-list",
        source: `from table {${tableId}}`,
        ui: { columns: [{ fieldId }] },
        ownerUserId: null,
        position: 0,
        deletedAt: null,
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z",
      },
    ],
  };
  next.formsByTable = {
    [tableId]: [
      {
        id: "FORM01",
        tableId,
        name: "Request item",
        config: { fields: [] },
        publicToken: null,
        isActive: true,
        ownerUserId: null,
        position: 0,
        isDefault: false,
        deletedAt: null,
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z",
      },
    ],
  };
  return next;
};

describe("CustomAppBuilder", () => {
  test("renders the extracted chart controls with existing labels and formatting values", () => {
    const html = renderToString(() =>
      createComponent(CustomAppChartEditor, {
        block: {
          id: "chart",
          type: "chart",
          source: { kind: "view", viewId: "VIEW01" },
          chartType: "bar",
          limit: 10,
          subtitle: "Chart subtitle",
          valueFormat: { style: "number", unit: "EUR", decimalPlaces: 2, unitPosition: "suffix" },
        },
        update: () => {},
      }),
    );
    for (const label of ["Chart settings", "Subtitle", "Chart type", "Result limit", "Decimal places", "Unit position"])
      expect(html).toContain(label);
    expect(html).toContain("Chart subtitle");
    expect(html).toContain("EUR");
  });

  test("renders HTML controls without clearing an unavailable field reference", () => {
    const html = renderToString(() =>
      createComponent(CustomAppHtmlEditor, {
        block: { id: "html", type: "html", fieldId: "FIELD1", height: "large" },
        fields: [],
        error: "Unavailable field",
        update: () => {},
      }),
    );
    expect(html).toContain("HTML template field");
    expect(html).toContain("FIELD1");
    expect(html).toContain("Unavailable field");
    expect(html).toContain("Large");
  });

  test("creates a blank schema v5 draft without legacy condition inputs", () => {
    const blank = blankCustomAppDefinition(app());

    expect(blank.schemaVersion).toBe(5);
    expect(blank.pages[0]?.rows[0]?.columns[0]?.blocks[0]).toEqual({
      id: "intro",
      type: "markdown",
      markdown: "",
    });
    expect(JSON.stringify(blank)).not.toContain("visibleWhen");
    expect(JSON.stringify(blank)).not.toContain('"inputs"');
  });

  test("keeps a valid definition editable when its stored capabilities are unavailable", () => {
    const stale = app();
    stale.draftCapabilities = null;
    stale.draftValid = false;
    const html = renderToString(() =>
      createComponent(CustomAppBuilder, { app: stale, baseId: "BASE01", catalog: catalog(), editMode: true }),
    );
    expect(html).toContain("The saved draft must be fixed before it can be published.");
    expect(html).toContain("Review draft");
    expect(html).toContain('class="mt-3 flex flex-wrap gap-2"');
    expect(html).toContain("Choose a request.");
    expect(html).toContain("Overview");
  });

  test("lists exact implicit context keys for the selected page", () => {
    const page = app().draftDefinition!.pages[0]!;
    page.parameters = {
      record_id: {
        type: "record",
        tableId: "TABLE1",
        required: true,
      },
    };

    expect(customAppContextKeys(page)).toEqual([
      "auth.id",
      "auth.name",
      "auth.username",
      "auth.email",
      "auth.subjects",
      "page.id",
      "page.title",
      "page.url",
      "app.id",
      "app.name",
      "base.id",
      "base.name",
      "time.now",
      "time.today",
      "time.timeZone",
      "params.record_id",
    ]);
  });

  test("creates valid GQL starters without requiring a saved view", () => {
    const authoringCatalog = catalogWithAuthoringResources();
    authoringCatalog.viewsByTable = {};

    expect(customAppStarterGqlSources(authoringCatalog)).toEqual({
      records: {
        kind: "gql",
        query: "from table {TABLE1}",
      },
      metrics: {
        kind: "gql",
        query: "from table {TABLE1}\naggregate count(*) as total",
      },
      chart: {
        kind: "gql",
        query: "from table {TABLE1}\ngroup by {FIELD1}\naggregate count(*) as total",
      },
    });
  });

  test("explains why the start page cannot require a record", () => {
    const html = renderToString(() =>
      createComponent(CustomAppBuilder, { app: app(), baseId: "BASE01", catalog: catalogWithAuthoringResources(), editMode: true }),
    );

    expect(html).toContain("Start pages open without a record");
    expect(html).toContain('title="Make another page the start page first."');
    expect(html).toMatch(/title="Make another page the start page first\."[\s\S]{0,180}disabled[\s\S]{0,180}Add record parameter/);
  });

  test("shows an actionable placeholder for empty Markdown", () => {
    const html = renderToString(() =>
      createComponent(CustomAppBlockPreview, {
        block: { id: "intro", type: "markdown", markdown: "" },
        baseId: app().baseId,
        appId: app().id,
        catalog: catalog(),
      }),
    );

    expect(html).toContain("Empty Markdown block");
    expect(html).toContain("Select this block to add text or context placeholders.");
    expect(html).toContain("k2b-placeholder");
  });

  test("highlights available Markdown placeholders in the builder preview", () => {
    const preview = app();
    const block = preview.draftDefinition!.pages[0]!.rows[0]!.columns[0]!.blocks[0]!;
    if (block.type !== "markdown") throw new Error("Expected Markdown fixture");
    block.markdown = "# Hello @auth.name and support@example.test";

    const html = renderToString(() =>
      createComponent(CustomAppBuilder, { app: preview, baseId: "BASE01", catalog: catalog(), editMode: true }),
    );

    expect(html).toContain('<span class="k2b-content-markdown__inline-token">@auth.name</span>');
    expect(html).toContain("support@example.test");
  });

  test("previews Scanner blocks without activating the camera", () => {
    const html = renderToString(() =>
      createComponent(CustomAppBlockPreview, {
        block: {
          id: "returns",
          type: "scanner",
          title: "Return items",
          launcherId: "55555555-5555-4555-8555-555555555555",
        },
        baseId: app().baseId,
        appId: app().id,
        catalog: catalog(),
      }),
    );

    expect(html).not.toContain("Return items");
    expect(html).toContain("Open the published app to use the camera");
    expect(html).toContain("k2b-placeholder");
  });

  test("keeps Rendered HTML contextual in the builder preview", () => {
    const html = renderToString(() =>
      createComponent(CustomAppBlockPreview, {
        block: { id: "equipment-card", type: "html", fieldId: "HTML01", height: "normal" },
        baseId: app().baseId,
        appId: app().id,
        catalog: catalog(),
      }),
    );

    expect(html).toContain("Rendered HTML");
    expect(html).toContain("record in the published app");
    expect(html).not.toContain("<iframe");
  });

  test("previews configured Records row actions without enabling them", () => {
    const tableId = "TABLE1";
    const fieldId = "FIELD1";
    const rowId = "44444444-4444-4444-8444-444444444444";
    const launcherId = "55555555-5555-4555-8555-555555555555";
    const html = renderToString(() =>
      createComponent(CustomAppBlockPreview, {
        block: {
          id: "items",
          type: "records",
          searchable: true,
          pageSize: 25,
          source: { kind: "gql", query: `from table {${tableId}}` },
          display: { kind: "table", columnIds: [] },
          rowActions: [
            {
              id: "reserve",
              label: "Reserve",
              icon: "bolt",
              showLabel: true,
              kind: "workflow",
              launcherId,
              inputs: {},
            },
            {
              id: "inspect",
              label: "Inspect",
              icon: "eye",
              showLabel: false,
              kind: "workflow",
              launcherId,
              inputs: {},
            },
          ],
        },
        baseId: app().baseId,
        appId: app().id,
        catalog: catalogWithAuthoringResources(),
        initialResult: {
          ok: true,
          mode: "rows",
          columns: [{ key: "name", label: "Name", tableId, fieldId, type: "text", sqlType: "text" }],
          rows: [{ recordId: rowId, tableId, values: { name: "Camera" } }],
          limit: 100,
        },
      }),
    );

    expect(html).toContain("Reserve");
    expect(html).toContain('aria-label="Inspect"');
    expect(html).toContain("ti-eye");
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("renders focused App settings with the permission boundary and no sidebar editor", () => {
    const html = renderToString(() =>
      createComponent(CustomAppSettings, {
        appId: "APP001",
        definition: app().draftDefinition!,
        defaultTab: "access",
        onNameChange: () => {},
        onIconChange: () => {},
        onClose: () => {},
        status: "Saving changes automatically…",
        error: false,
        lifecycle: null,
      }),
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain("General");
    expect(html).toContain("Lifecycle");
    expect(html).toContain("App grants are separate from Base access");
    expect(html).toContain("Record API, or GQL");
    expect(html).toContain("Workflow actions require a signed-in user");
    expect(html).toContain("Loading access");
    expect(html).toContain("Saving changes automatically…");
    expect(html).not.toContain("App sidebar");
    expect(html).not.toContain("Add Form");
  });

  test.each(["general", "access", "lifecycle"] as const)("keeps autosave errors inside the %s settings body", (defaultTab) => {
    const html = renderToString(() =>
      createComponent(CustomAppSettings, {
        appId: "APP001",
        definition: app().draftDefinition!,
        onNameChange: () => {},
        onIconChange: () => {},
        onClose: () => {},
        status: "Could not save draft",
        defaultTab,
        error: true,
        lifecycle: null,
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not save draft");
    const panel = html.match(/<section[^>]*role="tabpanel"[\s\S]*<\/section>/)?.[0];
    expect(panel).toContain("Could not save draft");
    expect(panel).toMatch(/<\/section>[\s\S]*<article[^>]*class="[^"]*mt-6[^"]*"[\s\S]*Could not save draft/);
    expect(html).not.toContain("<footer");
  });

  test("renders settings and permission guidance in the inherited German locale", () => {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(CustomAppSettings, {
            appId: "APP001",
            definition: app().draftDefinition!,
            defaultTab: "access",
            onNameChange: () => {},
            onIconChange: () => {},
            onClose: () => {},
            status: "Gespeichert",
            error: false,
            lifecycle: null,
          });
        },
      }),
    );
    expect(html).toContain("Allgemein");
    expect(html).toContain("Lebenszyklus");
    expect(html).toContain("App-Berechtigungen sind unabhängig vom Base-Zugriff");
    expect(html).toContain("Workflow-Aktionen erfordern einen angemeldeten Nutzer");
  });

  test("renders confirmed lifecycle actions for a published App", async () => {
    const published = app();
    published.publishedAt = "2026-08-11T10:00:00.000Z";
    published.publishedDefinition = published.draftDefinition;
    published.publishedCapabilities = published.draftCapabilities;
    published.publishedValid = true;
    const html = renderToString(() =>
      createComponent(CustomAppSettings, {
        appId: published.id,
        definition: published.draftDefinition!,
        defaultTab: "lifecycle",
        onNameChange: () => {},
        onIconChange: () => {},
        onClose: () => {},
        status: "Saved",
        error: false,
        get lifecycle() {
          return createComponent(CustomAppLifecycleActions, { app: published, baseId: "BASE01", onUnpublished: () => {} });
        },
      }),
    );
    const source = await Bun.file(resolve(import.meta.dir, "CustomAppBuilder.tsx")).text();

    expect(html).toContain("Unpublish app");
    expect(html).toContain("Delete app");
    expect(source).toContain('apiClient.apps[":appId"].unpublish.$post');
    expect(source).toContain('apiClient.apps[":appId"].$delete');
    expect(source).toContain("messages().deleteConfirm");
    expect(source).toContain("window.location.assign(`/app/grids/");
  });

  test("recognizes source diagnostics for one selected block", () => {
    expect(
      isCustomAppBlockSourceDiagnostic({ path: ["pages", "overview", "blocks", "records", "source"], message: "Invalid" }, "records"),
    ).toBe(true);
    expect(
      isCustomAppBlockSourceDiagnostic({ path: ["pages", "overview", "blocks", "records", "display"], message: "Invalid" }, "records"),
    ).toBe(false);
    expect(
      isCustomAppBlockSourceDiagnostic({ path: ["pages", "overview", "blocks", "other", "source"], message: "Invalid" }, "records"),
    ).toBe(false);
  });

  test("recognizes availability diagnostics for one selected target", () => {
    expect(
      isCustomAppAvailabilityDiagnostic(
        { path: ["pages", "overview", "blocks", "records", "availableWhen"], message: "Invalid" },
        "records",
      ),
    ).toBe(true);
    expect(
      isCustomAppAvailabilityDiagnostic({ path: ["pages", "overview", "blocks", "records", "source"], message: "Invalid" }, "records"),
    ).toBe(false);
  });

  test("progressively discloses optional availability GQL", () => {
    const always = renderToString(() =>
      createComponent(CustomAppAvailabilitySection, {
        baseId: app().baseId,
        contextKeys: ["auth.id", "time.now"],
        targetLabel: "Overview",
        value: () => "",
        onValueChange: () => undefined,
      }),
    );
    const custom = renderToString(() =>
      createComponent(CustomAppAvailabilitySection, {
        baseId: app().baseId,
        contextKeys: ["auth.id", "time.now"],
        targetLabel: "Overview",
        value: () => "from table Loans where record.createdBy = @auth.id",
        onValueChange: () => undefined,
      }),
    );

    expect(always).toContain("Always");
    expect(always).not.toContain("ti ti-minus");
    expect(always).toContain("Add rule");
    expect(always).not.toContain("Open large editor");
    expect(custom).toContain("Custom rule");
    expect(custom).toContain("Open large editor");
    expect(custom).toMatch(/<section class="k2b-detail-panel__section"[^>]*data-open="true"/);
  });

  test("keeps compact Markdown editing focused and moves placeholder browsing to the large editor", () => {
    const html = renderToString(() =>
      createComponent(CustomAppMarkdownField, {
        contextKeys: ["auth.name", "auth.email", "params.record_id"],
        value: () => "Hello @auth.name",
        onValueChange: () => undefined,
      }),
    );

    expect(html).toContain("k2b-markdown-editor");
    expect(html).not.toContain("Add placeholder");
    expect(html).toContain("Open large editor");
  });

  test("renders fail-closed recovery for an incompatible stored draft", () => {
    const legacy = app();
    legacy.draftDefinition = null;
    legacy.draftDiagnostics = [
      {
        path: ["draft", "schemaVersion"],
        message: "Stored draft uses unsupported App schemaVersion 1.",
      },
    ];
    legacy.draftValid = false;
    legacy.publishedDefinition = app().draftDefinition;
    legacy.publishedCapabilities = legacy.draftCapabilities;
    legacy.publishedAt = "2026-08-07T00:00:00.000Z";
    legacy.publishedValid = true;

    const html = renderToString(() =>
      createComponent(CustomAppBuilder, { app: legacy, baseId: "BASE01", catalog: catalog(), editMode: true }),
    );

    expect(html).toContain("This draft cannot be opened");
    expect(html).toContain("schemaVersion 1");
    expect(html).not.toContain("Download stored JSON");
    expect(html).toContain("Restore live version");
    expect(html).toContain("Replace with blank schema v5 draft");
    expect(html).toContain("Unpublish app");
    expect(html).toContain("Delete app");
    expect(html).not.toContain("App canvas");
  });

  test("renders one editor navigation, the canvas, and inspector from the canonical draft", () => {
    const html = renderToString(() =>
      createComponent(CustomAppBuilder, { app: app(), baseId: "BASE01", catalog: catalog(), editMode: true }),
    );

    expect(html).toContain("k2b-app-workspace__main-pane");
    expect(html).not.toContain("App builder");
    expect(html).not.toContain("Draft only");
    expect(html).toContain("Overview");
    expect(html).toContain("Welcome");
    expect(html).toContain("Choose a request.");
    expect(html).toContain("k2b-app-workspace__detail");
    expect(html).toContain("Page settings");
    expect(html).toContain("Add block");
    expect(html).toContain("New page");
    expect(html).toContain("New action");
    expect(html).toMatch(/Choose a request\.[\s\S]*Add block/);
    expect(html).toMatch(/class="flex justify-center"[\s\S]*Add block/);
    expect(html).not.toContain("Show outlines");
    expect(html).not.toContain("Hide outlines");
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain("data-show-block-outlines");
    expect(html).not.toContain("Add row");
    expect(html).not.toContain("Add column");
    expect(html).toContain('class="custom-app-page ');
    expect(html).toContain('class="custom-app-block ');
    expect(html).toContain('aria-label="Select and move Markdown"');
    expect(html).toContain('data-custom-app-dnd-handle="block"');
    expect(html).toContain("data-dnd-preview");
    expect(html).toContain('data-zone="before"');
    expect(html).toContain('data-zone="left"');
    expect(html).not.toContain('data-zone="column-left"');
    expect(html).not.toContain('data-zone="column-right"');
    expect(html).toContain('class="custom-app-drop-indicator"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('class="k2b-content-markdown ');
    expect(html).toContain("Close inspector");
    expect(html).toContain("k2b-detail-panel__body");
    expect(html).toContain('class="k2b-detail-panel__summary"');
    expect(html).toContain("Route parameters");
    expect(html).toContain('class="k2b-detail-panel__group" role="group" aria-label="Page behavior"');
    expect(html).toContain('class="k2b-detail-panel__group" role="group" aria-label="Page management"');
    expect(html).not.toContain('role="group" aria-label="Page settings"');
    expect(html).toContain("Show in app navigation");
    expect(html).toContain("Availability");
    expect(html).toContain("Open large editor");
    expect(html).toMatch(/k2b-app-workspace__sidebar-body[\s\S]*k2b-app-workspace__sidebar-footer[\s\S]*This app is a draft/);
    expect(html).toMatch(/k2b-app-workspace__sidebar-footer[^>]*>[\s\S]*k2b-notice-card/);
    expect(html).not.toContain("grids-builder-block");
    expect(html).not.toContain("custom-app-row-control");
    expect(html).not.toContain("custom-app-column-control");
    expect(html).not.toContain("custom-app-editor-label");
    expect(html).not.toContain('class="paper');
    expect(html).not.toContain("border-b border-subtle");
    expect(html).not.toContain("border-t border-subtle");
  });

  test("distinguishes live state from unpublished draft changes", () => {
    const published = app();
    published.publishedAt = "2026-08-11T10:00:00.000Z";
    published.publishedDefinition = published.draftDefinition;
    published.publishedCapabilities = published.draftCapabilities;
    published.publishedValid = true;
    published.hasUnpublishedChanges = true;

    const html = renderToString(() =>
      createComponent(CustomAppBuilder, { app: published, baseId: "BASE01", catalog: catalog(), editMode: true }),
    );

    expect(html).not.toContain("Unpublished changes");
    expect(html).toContain("Changes are in a draft");
    expect(html).not.toContain('label="Published"');
  });

  test("previews and authors page-independent sidebar Forms", async () => {
    const sidebarApp = app();
    sidebarApp.draftDefinition!.sidebar = {
      actions: [
        {
          id: "new-request",
          kind: "form",
          label: "New request",
          tone: "default",
          formId: "FORM01",
          fixedValues: {},
        },
      ],
    };

    const html = renderToString(() =>
      createComponent(CustomAppBuilder, {
        app: sidebarApp,
        baseId: "BASE01",
        catalog: catalogWithAuthoringResources(),
        editMode: true,
      }),
    );
    const source = await Bun.file(resolve(import.meta.dir, "CustomAppBuilder.tsx")).text();

    expect(html).toContain("Actions");
    expect(html).toContain("New request");
    expect(html).toContain("New action");
    expect(source).not.toContain('title={text("App sidebar")}');
    expect(source).not.toContain('text("Add Form")');
    expect(source).toContain("<Show when={selectedSidebarAction()}>");
    expect(source).not.toContain("<AppWorkspace.SidebarItemLabel>{action.label}");
    expect(source).toContain('tone={props.editMode ? "default" : action.tone}');
    expect(source).not.toContain('text("Add Workflow")');
    expect(source).toContain('text("Hide this input and inject one trusted value on the server.")');
    expect(source).toContain('<PanelDialog.Header title={text("Choose block type")}');
    expect(source).toContain('class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"');
    expect(source).toContain('option.disabled ? "text-[var(--k2b-warning-text)]" : "text-dimmed"');
    expect(source).not.toContain("<Dropdown.Root");
  });

  test("renders a clean app preview outside Edit mode", () => {
    const preview = app();
    const block = preview.draftDefinition!.pages[0]!.rows[0]!.columns[0]!.blocks[0]!;
    if (block.type !== "markdown") throw new Error("Expected Markdown fixture");
    block.markdown += "\n\n@auth.name";
    preview.draftDefinition!.sidebar = {
      actions: [
        {
          id: "new-request",
          kind: "form",
          label: "New request",
          tone: "default",
          formId: "FORM01",
          fixedValues: {},
        },
      ],
    };

    const html = renderToString(() =>
      createComponent(CustomAppBuilder, {
        app: preview,
        baseId: "BASE01",
        catalog: catalogWithAuthoringResources(),
        editMode: false,
      }),
    );

    expect(html).toContain("Overview");
    expect(html).toContain("Choose a request.");
    expect(html).toContain("Actions");
    expect(html).toContain("New request");
    expect(html).not.toContain("Add block");
    expect(html).not.toContain("New page");
    expect(html).not.toContain("New action");
    expect(html).not.toContain('aria-label="Select and move Markdown"');
    expect(html).not.toContain("k2b-content-markdown__inline-token");
    expect(html).not.toContain("custom-app-drop-indicator");
    expect(html).toMatch(/<aside id="k2b-workspace-detail-custom-app-inspector"[^>]* hidden/);
    expect(html).not.toContain("Draft only");
    expect(html).not.toContain("This app is a draft");
  });

  test("uses shared large editors and documented DetailPanel groups", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "CustomAppBuilder.tsx")).text();
    const gqlFieldSource = await Bun.file(resolve(import.meta.dir, "CustomAppGqlField.tsx")).text();
    const markdownFieldSource = await Bun.file(resolve(import.meta.dir, "CustomAppMarkdownField.tsx")).text();
    const createAppSource = await Bun.file(resolve(import.meta.dir, "../sidebar/create-custom-app.tsx")).text();
    const gqlSettings = source.slice(source.indexOf('<Show when={selectedSourceBlock()?.source.kind === "gql"}>'));

    expect(gqlSettings).toContain("<CustomAppGqlField");
    expect(gqlSettings).toContain("baseId={draft.draft().baseId}");
    expect(gqlSettings).toContain("contextKeys={contextKeys()}");
    expect(gqlSettings).not.toMatch(/<TextInput[\s\S]{0,240}label="GQL"/);
    expect(source).not.toContain("param('name')");
    expect(source).not.toContain("visibleWhen");
    expect(source).not.toContain("source.inputs");
    expect(gqlFieldSource).toContain("<PanelDialog.Body scrollPreserveKey={`custom-app-gql-${props.dialogTitle}`}>");
    expect(gqlFieldSource).toContain('class="flex min-h-0 flex-1 flex-col gap-4"');
    expect(gqlFieldSource).not.toContain("<PanelDialog.Section");
    expect(gqlFieldSource).toContain('icon={null} variant="text"');
    expect(markdownFieldSource).toContain("<MarkdownEditor");
    expect(markdownFieldSource).toContain('trigger: "@"');
    expect(markdownFieldSource).toContain('text({ value: "Add placeholder" })');
    expect(markdownFieldSource).toContain("<PanelDialog.Body");
    expect(markdownFieldSource).not.toContain("<PanelDialog.Section");
    expect(createAppSource).toContain("subtitle={t.newAppSubtitle}");
    expect(createAppSource).not.toContain("<PanelDialog.Section");
    expect(source).toContain("<CustomAppSettings");
    expect(source).not.toContain('text("Block order")');
    expect(source).not.toContain("const moveSelectedBlock =");
    expect(source).not.toContain('<DetailPanel.Group label={text("App settings")}>');
    expect(source).toContain('<DetailPanel.Summary title={text("Page")}>');
    expect(source).toContain('title={text("Route parameters")}');
    expect(source).toContain('<DetailPanel.Group label={text("Page behavior")}>');
    expect(source).toContain('<DetailPanel.Group label={text("Page management")}>');
    expect(source).toContain('<DetailPanel.Summary title={text("Block")}>');
    expect(source).toContain('<DetailPanel.Group label={text("Block behavior")}>');
    expect(source).toContain('<DetailPanel.Group label={text("Data settings")}>');
    expect(source).toContain('<DetailPanel.Group label={text("Referenced records settings")}>');
    expect(source).toContain('label={text("Source table")}');
    expect(source).toContain('label={text("Relation field")}');
    expect(source).toContain('type: "referenced_records"');
    expect(source).toContain('title={text("Data source")}');
    expect(source).toContain('title={text("Records table")}');
    expect(source).toContain('title={text("Row actions")}');
    expect(source).toContain("addRowWorkflowAction");
    expect(source).toContain('label={text("Show label in table")}');
    expect(source).toContain("app().draftCapabilities?.recordQueries.find");
    expect(source).toContain('"showLabel" in action && !icon ? { ...action, icon, showLabel: true }');
    expect(source).toContain("disabled={!selected().action.icon}");
    expect(source).toContain('text("Let readers view and download existing documents for the page record.")');
    expect(source).toContain('text("Workflow actions are available only to signed-in app readers.")');
    expect(source).toContain("WorkflowPrerequisiteGuidance");
    expect(source).toContain('text("Create and connect record page")');
    expect(source).toContain('text("Start pages open without a required record.")');
    expect(source).toContain('text("Supplied values are hidden from the Form and injected again by the server when it is submitted.")');
    expect(source).toContain("openWorkflowConfiguration(selectedLauncher()?.workflowId)");
    expect(source).not.toContain("<Placeholder");
    expect(source).not.toContain("Resolved fields appear after the GQL preview succeeds.");
    expect(source).toContain('<DetailPanel.Group label={text("Form settings")}>');
    expect(source).toContain('<DetailPanel.Group label={text("Scanner settings")}>');
    expect(source).toContain('title={text("Values supplied by this page")}');
    expect(source).not.toContain('title="Prefilled relations"');
    expect(source).toContain('<DetailPanel.Group label={text("Record settings")}>');
    const chartSource = await Bun.file(new URL("./CustomAppChartEditor.tsx", import.meta.url)).text();
    expect(chartSource).toContain('<DetailPanel.Group label={text("Chart settings")}>');
    expect(source).toContain("<CustomAppChartEditor");
    expect(source).toContain('<DetailPanel.Group label={text("Block management")}>');
    expect(source).not.toContain('<DetailPanel.Group label="Page settings">');
    expect(source).not.toContain('<DetailPanel.Group label="Block settings">');
    expect(source).not.toContain("<Disclosure");
    expect(source).toContain('<DetailPanel.Group label={text("Action settings")}>');

    let groupDepth = 0;
    for (const match of source.matchAll(/<\/?DetailPanel\.(?:Group|Section)\b[^>]*>/g)) {
      const token = match[0];
      if (token.startsWith("</DetailPanel.Group")) {
        groupDepth -= 1;
      } else if (token.startsWith("<DetailPanel.Group")) {
        groupDepth += 1;
      } else if (token.startsWith("<DetailPanel.Section")) {
        expect(groupDepth).toBeGreaterThan(0);
      }
    }
    expect(groupDepth).toBe(0);
  });

  test("uses the workspace edit accent for selected and focused blocks", async () => {
    const css = await Bun.file(resolve(import.meta.dir, "../../../styles/app.css")).text();

    expect(css).toMatch(/\.grids-workspace-editing\s*\{[^}]*--grids-edit-accent:/);
    expect(css).not.toMatch(/\.custom-app-page\s*\{/);
    expect(css).toMatch(
      /\.custom-app-block\[data-editing="true"\]\s*\{[^}]*min-height:\s*var\(--ui-control-sm\);[^}]*outline:\s*1px dashed/,
    );
    expect(css).not.toContain("data-show-block-outlines");
    expect(css).toMatch(/\.custom-app-block:hover\s*>\s*\.custom-app-block-control\s*\{[^}]*opacity:\s*1/);
    expect(css).toMatch(/@media \(hover: none\)[\s\S]*?\.custom-app-block\s*>\s*\.custom-app-block-control\s*\{[^}]*opacity:\s*1/);
    expect(css).not.toContain('.custom-app-block[data-selected="true"] > .custom-app-block-control');
    expect(css).toMatch(/\.custom-app-block\[data-selected="true"\]\s*\{[^}]*outline:\s*1px solid var\(--grids-edit-accent\)/);
    expect(css).toMatch(
      /\.custom-app-editor-control:focus-visible\s*>\s*\.custom-app-drag-preview\s*\{[^}]*outline:\s*2px solid var\(--grids-edit-accent\)/,
    );
    expect(css).not.toContain('.custom-app-block[data-selected="true"] > .custom-app-editor-control > .custom-app-drag-preview');
    expect(css).not.toContain("text-transform: uppercase");
    expect(css).toContain('.custom-app-page[data-dnd-dragging="true"] .custom-app-drop-zone');
    expect(css).toContain('.custom-app-page[data-dnd-dragging="true"] .custom-app-pair-drop-zone');
    expect(css).toContain('.custom-app-drop-zone[data-active="true"] > .custom-app-drop-indicator');
    expect(css).toMatch(/data-zone="before"\]\s*\{[^}]*top:\s*-1\.5rem;[^}]*right:\s*0;[^}]*left:\s*0;[^}]*height:\s*1\.5rem/);
    expect(css).toMatch(/data-zone="after"\]\s*\{[^}]*right:\s*0;[^}]*bottom:\s*-1\.5rem;[^}]*left:\s*0;[^}]*height:\s*1\.5rem/);
    expect(css).toMatch(/data-zone="before"[^}]*>[^{]*\.custom-app-drop-indicator[\s\S]*?right:\s*0;[\s\S]*?left:\s*0/);
    expect(css).toMatch(/data-zone="row-before"\],[\s\S]*?data-zone="row-after"\]\s*\{[^}]*right:\s*0;[^}]*left:\s*0;[^}]*height:\s*2rem/);
    expect(css).toMatch(/data-zone="row-before"\]\s*\{[^}]*top:\s*-2rem/);
    expect(css).toMatch(/data-zone="row-after"\]\s*\{[^}]*bottom:\s*-2rem/);
    expect(css).toMatch(/data-zone="left"\],[\s\S]*?data-zone="right"\]\s*\{[^}]*top:\s*0;[^}]*bottom:\s*0;[^}]*width:\s*25%/);
    expect(css).toMatch(/data-zone="left"[^}]*>[^{]*\.custom-app-drop-indicator[\s\S]*?top:\s*0;[\s\S]*?bottom:\s*0/);
    expect(css).toMatch(/data-zone="column-left"\]\[data-between-columns="true"\]\s*\{[^}]*left:\s*-0\.75rem/);
    expect(css).toMatch(/data-zone="column-left"[^}]*>[^{]*\.custom-app-drop-indicator,[\s\S]*?transform:\s*translateX\(-50%\)/);
    expect(css).toMatch(/data-zone="column-right"[^}]*>[^{]*\.custom-app-drop-indicator,[\s\S]*?transform:\s*translateX\(50%\)/);
    expect(css).toMatch(
      /\.custom-app-pair-drop-zone\s*\{[^}]*position:\s*relative;[^}]*grid-column:\s*1;[^}]*align-self:\s*stretch;[^}]*width:\s*25%/,
    );
    expect(css).toMatch(/\.custom-app-pair-indicator\s*\{[^}]*top:\s*0;[^}]*bottom:\s*0;[^}]*width:\s*0\.375rem/);
  });

  test("uses the represented pair height as the pair collision zone", () => {
    const pairApp = app();
    pairApp.draftDefinition!.pages[0]!.rows[0]!.columns[0]!.blocks.push({
      id: "actions",
      type: "actions",
      actions: [],
    });

    const html = renderToString(() =>
      createComponent(CustomAppBuilder, { app: pairApp, baseId: "BASE01", catalog: catalog(), editMode: true }),
    );

    expect(html).toContain('data-zone="pair-left"');
    expect(html).toContain('data-zone="pair-right"');
    expect(html.match(/class="custom-app-pair-drop-zone"/g)).toHaveLength(2);
    expect(html.match(/class="custom-app-pair-indicator"/g)).toHaveLength(2);
    expect(html.match(/data-zone="before"/g)).toHaveLength(2);
    expect(html.match(/data-zone="after"/g)).toHaveLength(1);
    expect(html).not.toContain('data-zone="column-left"');
    expect(html).not.toContain('data-zone="column-right"');
    expect(html).toContain('data-side="left"');
    expect(html).toContain('data-side="right"');
    expect(html.match(/grid-row:1 \/ span 2/g)).toHaveLength(2);
  });

  test("renders one canonical target for every multi-column insertion gap", () => {
    const columnApp = app();
    columnApp.draftDefinition!.pages[0]!.rows[0]!.columns = ["A", "B", "C"].map((id) => ({
      id: `column-${id}`,
      span: 4,
      blocks: [{ id, type: "markdown" as const, markdown: id }],
    }));

    const html = renderToString(() =>
      createComponent(CustomAppBuilder, { app: columnApp, baseId: "BASE01", catalog: catalog(), editMode: true }),
    );

    expect(html.match(/data-zone="column-left"/g)).toHaveLength(3);
    expect(html.match(/data-zone="column-right"/g)).toHaveLength(1);
    expect(html.match(/data-between-columns="true"/g)).toHaveLength(2);
    expect(html.match(/data-zone="row-before"/g)).toHaveLength(1);
    expect(html.match(/data-zone="row-after"/g)).toHaveLength(1);
    expect(html).not.toContain('data-zone="left"');
    expect(html).not.toContain('data-zone="right"');
    expect(html).not.toContain('data-zone="pair-left"');
    expect(html).not.toContain('data-zone="pair-right"');
  });

  test("defines typed Records and Form choices for the block picker", async () => {
    const html = renderToString(() =>
      createComponent(CustomAppBuilder, { app: app(), baseId: "BASE01", catalog: catalogWithAuthoringResources(), editMode: true }),
    );
    const source = await Bun.file(resolve(import.meta.dir, "CustomAppBuilder.tsx")).text();

    expect(html).toContain("Add block");
    expect(source).toContain('description: text("Show records from a saved view or GQL query.")');
    expect(source).toContain('description: text("Embed an active Form.")');
    expect(source).toContain('description: text("Create a table with fields first.")');
    expect(source).toContain('description: text("Create and activate a Form first.")');
  });

  test("renders the complete shared Form UI without enabling submission", () => {
    const formApp = app();
    formApp.draftDefinition!.pages[0]!.rows[0]!.columns[0]!.blocks = [
      {
        id: "request-form",
        type: "form",
        title: "Request a loan",
        formId: "FORM01",
        fixedValues: {},
      },
    ];

    const html = renderToString(() =>
      createComponent(CustomAppBuilder, { app: formApp, baseId: "BASE01", catalog: catalogWithAuthoringResources(), editMode: true }),
    );

    expect(html).toContain('aria-label="Select and move Form"');
    expect(html).toContain("Request a loan");
    expect(html).not.toContain(">Request item<");
    expect(html).toContain("k2b-panel-header");
    expect(html).toContain('class="w-full flex flex-col gap-4"');
    expect(html).not.toContain("max-w-xl");
    expect(html).toContain("data-grids-public-form-ready");
    expect(html).toMatch(/type="submit"[^>]*disabled/);
    expect(html).not.toContain('class="paper');
  });
});
