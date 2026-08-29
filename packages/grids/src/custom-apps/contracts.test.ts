import { describe, expect, test } from "bun:test";
import {
  CUSTOM_APP_REFERENCE,
  CustomAppCapabilitiesSchema,
  CustomAppCommentsBlockSchema,
  CustomAppDefinitionSchema,
  CustomAppHtmlBlockSchema,
  parseStoredCustomAppDefinition,
} from "./contracts";
import { customAppScannerConfigHash } from "./scanner-capability";

const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const definition = () => ({
  schemaVersion: 5,
  kind: "grids.custom-app",
  id: "APP001",
  baseId: "BASE01",
  name: "Certificate requests",
  startPageId: "home",
  pages: [
    {
      id: "home",
      title: "Requests",
      rows: [
        {
          id: "intro",
          columns: [
            { id: "copy", span: 4, blocks: [{ id: "welcome", type: "markdown", markdown: "# Welcome" }] },
            {
              id: "records",
              span: 8,
              blocks: [
                {
                  id: "requests",
                  type: "records",
                  searchable: true,
                  pageSize: 25,
                  source: { kind: "view", viewId: "VIEW01" },
                  display: { kind: "table", columnIds: ["FIELD1"] },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

describe("Grids App definition contract", () => {
  test("uses only six-character public resource ids in schemaVersion 5", () => {
    const source = CUSTOM_APP_REFERENCE.example;
    expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(true);
    expect(CustomAppDefinitionSchema.safeParse({ ...source, id: uuid(1) }).success).toBe(false);
    expect(CustomAppDefinitionSchema.safeParse({ ...source, schemaVersion: 4 }).success).toBe(false);
  });

  test("accepts strict multi-page list and route-only record detail definitions", () => {
    expect(CustomAppDefinitionSchema.safeParse(definition()).success).toBe(true);
    expect(CustomAppDefinitionSchema.safeParse(CUSTOM_APP_REFERENCE.example).success).toBe(true);
  });

  test("allows a Rendered HTML field to be the only record-page content", () => {
    const source = CustomAppDefinitionSchema.parse(definition());
    source.pages.push({
      id: "item",
      title: "Item",
      navigation: { visible: false },
      parameters: { item_id: { type: "record", tableId: "TAB001", required: true } },
      record: { tableId: "TAB001", id: { source: "PARAMS", path: "item_id" } },
      rows: [
        {
          id: "card-row",
          columns: [{ id: "card-column", span: 12, blocks: [{ id: "card", type: "html", fieldId: "FLD001", height: "normal" }] }],
        },
      ],
    });
    const parsed = CustomAppDefinitionSchema.safeParse(source);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const block = parsed.data.pages[1]!.rows[0]!.columns[0]!.blocks[0]!;
      expect(block.type === "html" && block.height).toBe("normal");
    }
    expect(CustomAppHtmlBlockSchema.parse({ id: "card", type: "html", fieldId: "FLD001" }).height).toBe("normal");

    const withoutRecord = structuredClone(source);
    delete withoutRecord.pages[1]!.record;
    expect(CustomAppDefinitionSchema.safeParse(withoutRecord).success).toBe(false);
  });

  test("derives GQL Records columns from the query but requires saved-view columns", () => {
    const gql = CustomAppDefinitionSchema.parse(definition());
    const records = gql.pages[0]!.rows[0]!.columns[1]!.blocks[0]!;
    if (records.type !== "records") throw new Error("Expected Records block");
    records.source = { kind: "gql", query: "from table Requests\nselect Name, Status" };
    if (records.display.kind !== "table") throw new Error("Expected table display");
    records.display.columnIds = [];
    expect(CustomAppDefinitionSchema.safeParse(gql).success).toBe(true);

    records.source = { kind: "view", viewId: uuid(3) };
    expect(CustomAppDefinitionSchema.safeParse(gql).success).toBe(false);
  });

  test("supports navigable, actionable, and read-only Cards from a saved View", () => {
    const source = CustomAppDefinitionSchema.parse(definition());
    source.pages.push({
      id: "request",
      title: "Request",
      navigation: { visible: false },
      parameters: { request_id: { type: "record", tableId: "TAB009", required: true } },
      record: { tableId: "TAB009", id: { source: "PARAMS", path: "request_id" } },
      rows: [
        {
          id: "detail",
          columns: [{ id: "main", span: 12, blocks: [{ id: "record", type: "record", fieldIds: ["FLD004"], editableFieldIds: [] }] }],
        },
      ],
    });
    const records = source.pages[0]!.rows[0]!.columns[1]!.blocks[0]!;
    if (records.type !== "records") throw new Error("Expected Records block");
    records.display = { kind: "cards" };
    records.rowNavigate = {
      kind: "navigate",
      pageId: "request",
      history: "push",
      params: { request_id: { source: "ROW", path: "id" } },
    };
    expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(true);

    records.rowNavigate.params.request_id = { source: "ROW", path: "relation", fieldId: "FLD004" };
    expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(true);

    delete records.rowNavigate;
    records.rowActions = [{ id: "reserve", label: "Reserve", showLabel: true, kind: "workflow", launcherId: "LCH010", inputs: {} }];
    expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(true);

    delete records.rowActions;
    expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(true);

    records.source = { kind: "gql", query: "from table Requests" };
    expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(false);
  });

  test("allows exact referenced records only on a matching Record page", () => {
    const source = CustomAppDefinitionSchema.parse(structuredClone(CUSTOM_APP_REFERENCE.example));
    const detail = source.pages.find((page) => page.record)!;
    detail.rows[0]!.columns[0]!.blocks.push({
      id: "related-orders",
      type: "referenced_records",
      sourceTableId: "ORDER1",
      relationFieldId: "CUSTOM",
      fieldIds: ["NUMBER", "STATUS"],
      display: { kind: "table" },
      searchable: true,
      pageSize: 25,
    });
    expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(true);

    const duplicateFields = structuredClone(source);
    const duplicateBlock = duplicateFields.pages[1]!.rows[0]!.columns[0]!.blocks.at(-1)!;
    if (duplicateBlock.type !== "referenced_records") throw new Error("Expected Referenced records block");
    duplicateBlock.fieldIds = ["NUMBER", "NUMBER"];
    expect(CustomAppDefinitionSchema.safeParse(duplicateFields).success).toBe(false);

    source.pages[0]!.rows[0]!.columns[0]!.blocks.push(source.pages[1]!.rows[0]!.columns[0]!.blocks.at(-1)!);
    expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(false);
  });

  test("keeps the live Help YAML aligned with the public schema", async () => {
    const markdown = await Bun.file(new URL("../help/documents/en/grids-custom-apps.help.md", import.meta.url)).text();
    const source = markdown.match(/```yaml\n([\s\S]*?)```/)?.[1];
    expect(source).toBeDefined();
    expect(CustomAppDefinitionSchema.safeParse(Bun.YAML.parse(source!)).success).toBe(true);
  });

  test("accepts the parameter-only article entry fixture", async () => {
    const source = await Bun.file(new URL("../../docs/custom-apps/article-entry.yaml", import.meta.url)).text();
    const parsed = CustomAppDefinitionSchema.safeParse(Bun.YAML.parse(source));
    expect(parsed.success).toBe(true);
  });

  test("rejects unknown keys instead of silently accepting future behavior", () => {
    expect(CustomAppDefinitionSchema.safeParse({ ...definition(), script: "alert(1)" }).success).toBe(false);
  });

  test("accepts page-independent sidebar Forms with literals or current user", () => {
    const app = {
      ...definition(),
      sidebar: {
        actions: [
          {
            id: "create-request",
            kind: "form",
            label: "New request",
            icon: "plus",
            tone: "success",
            formId: "FRM020",
            fixedValues: {
              FLD021: { source: "LITERAL", value: "draft" },
              FLD024: { source: "AUTH", path: "currentUser" },
            },
          },
        ],
      },
    };
    expect(CustomAppDefinitionSchema.safeParse(app).success).toBe(true);
    const unsafe = {
      ...app,
      sidebar: {
        actions: [
          { ...app.sidebar.actions[0]!, fixedValues: { FLD021: { source: "PARAMS", path: "request_id" } } },
          ...app.sidebar.actions.slice(1),
        ],
      },
    };
    expect(CustomAppDefinitionSchema.safeParse(unsafe).success).toBe(false);
  });

  test("rejects legacy stored definitions without parsing them as live v5", () => {
    const legacy = { ...definition(), schemaVersion: 1, legacyMarker: { keep: true } };
    const inspected = parseStoredCustomAppDefinition(legacy, "draft");
    expect(inspected.definition).toBeNull();
    expect(inspected.diagnostics[0]?.path).toEqual(["draft", "schemaVersion"]);
    expect(inspected.diagnostics[0]?.message).toBe("Stored draft is not a valid Grids App schemaVersion 5 definition.");
    expect(legacy.legacyMarker).toEqual({ keep: true });
  });

  test("pins mutable saved Views to their compiled source", () => {
    const view = { viewId: uuid(10), tableId: uuid(11), tableIds: [uuid(11)] };
    expect(CustomAppCapabilitiesSchema.safeParse({ views: [view] }).success).toBe(false);
    expect(
      CustomAppCapabilitiesSchema.safeParse({ views: [{ ...view, sourceHash: "a".repeat(64), planHash: "b".repeat(64) }] }).success,
    ).toBe(true);
  });

  test("requires Record capabilities to pin relation targets and label fields", () => {
    const record = {
      pageId: "detail",
      tableId: uuid(20),
      fieldIds: [uuid(21)],
      editableFieldIds: [],
    };
    expect(CustomAppCapabilitiesSchema.safeParse({ views: [], records: [record] }).success).toBe(false);
    expect(
      CustomAppCapabilitiesSchema.safeParse({
        views: [],
        records: [
          {
            ...record,
            relationLabels: [{ fieldId: uuid(21), targetTableId: uuid(22), labelFieldIds: [uuid(23)] }],
          },
        ],
      }).success,
    ).toBe(true);
  });

  test("requires Form capabilities to pin their live field contract", () => {
    const form = {
      pageId: "home",
      blockId: "apply",
      formId: uuid(20),
      tableId: uuid(21),
      userInputFieldIds: [uuid(22)],
      fixedFieldIds: [],
    };
    expect(CustomAppCapabilitiesSchema.safeParse({ views: [], forms: [form] }).success).toBe(false);
    expect(
      CustomAppCapabilitiesSchema.safeParse({
        views: [],
        forms: [{ ...form, fieldHash: "a".repeat(64), formSecurityHash: "b".repeat(64) }],
      }).success,
    ).toBe(true);
  });

  test("accepts Scanner blocks and pins their exact launcher revision and configuration", () => {
    const source = CustomAppDefinitionSchema.parse(definition());
    source.pages[0]!.rows[0]!.columns[0]!.blocks.push({
      id: "returns",
      type: "scanner",
      launcherId: "LCH030",
    });
    expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(true);
    expect(
      CustomAppCapabilitiesSchema.safeParse({
        views: [],
        scannerLaunchers: [
          {
            pageId: "home",
            blockId: "returns",
            launcherId: uuid(30),
            workflowId: uuid(31),
            revision: 2,
            configHash: "a".repeat(64),
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      CustomAppCapabilitiesSchema.safeParse({
        views: [],
        scannerLaunchers: [
          {
            pageId: "home",
            blockId: "returns",
            launcherId: uuid(30),
            workflowId: uuid(31),
            revision: 2,
            configHash: "mutable",
          },
        ],
      }).success,
    ).toBe(false);
    const first = customAppScannerConfigHash({
      kind: "scanner",
      inputSources: { record: { kind: "scan", value: "record", resolve: { by: "scanCode" } }, note: { kind: "afterScan" } },
    });
    const reordered = customAppScannerConfigHash({
      kind: "scanner",
      inputSources: { note: { kind: "afterScan" }, record: { kind: "scan", value: "record", resolve: { by: "scanCode" } } },
    });
    expect(first).toBe(reordered);
    expect(first).not.toBe(customAppScannerConfigHash({ kind: "scanner", inputSources: { record: { kind: "scan", value: "text" } } }));
  });

  test("rejects invalid spans and duplicate page or block ids", () => {
    const invalidSpan = definition();
    invalidSpan.pages[0]!.rows[0]!.columns[1]!.span = 9;
    expect(CustomAppDefinitionSchema.safeParse(invalidSpan).success).toBe(false);

    const duplicate = definition();
    duplicate.pages[0]!.rows[0]!.columns[1]!.blocks[0]!.id = "welcome";
    expect(CustomAppDefinitionSchema.safeParse(duplicate).success).toBe(false);

    const duplicatePage = definition();
    duplicatePage.pages.push({ ...duplicatePage.pages[0]!, title: "Other" });
    expect(CustomAppDefinitionSchema.safeParse(duplicatePage).success).toBe(false);
  });

  test("rejects ambiguous field projections and unsafe icon values", () => {
    const duplicateField = definition();
    const records = duplicateField.pages[0]!.rows[0]!.columns[1]!.blocks[0]!;
    if ("display" in records) records.display.columnIds.push(records.display.columnIds[0]!);
    expect(CustomAppDefinitionSchema.safeParse(duplicateField).success).toBe(false);
    expect(CustomAppDefinitionSchema.safeParse({ ...definition(), icon: "app-window text-danger" }).success).toBe(false);
  });

  test("requires editable Record fields to be part of the displayed allowlist", () => {
    const example = CustomAppDefinitionSchema.parse(structuredClone(CUSTOM_APP_REFERENCE.example));
    const detail = example.pages.find((page) => page.record)!;
    const record = detail.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks)).find((block) => block.type === "record")!;
    if (record.type !== "record") throw new Error("Expected Record block");
    record.editableFieldIds = [record.fieldIds[0]!];
    expect(CustomAppDefinitionSchema.safeParse(example).success).toBe(true);
    record.editableFieldIds = [record.fieldIds[0]!, record.fieldIds[0]!];
    expect(CustomAppDefinitionSchema.safeParse(example).success).toBe(false);
    record.editableFieldIds = [uuid(99)];
    expect(CustomAppDefinitionSchema.safeParse(example).success).toBe(false);
  });

  test("accepts an exact Record document template allowlist and rejects duplicates", () => {
    const example = CustomAppDefinitionSchema.parse(structuredClone(CUSTOM_APP_REFERENCE.example));
    const detail = example.pages.find((page) => page.record)!;
    const record = detail.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks)).find((block) => block.type === "record")!;
    if (record.type !== "record") throw new Error("Expected Record block");
    expect(record.documents?.templateIds).toHaveLength(1);
    record.documents = { templateIds: [uuid(70), uuid(70)] };
    expect(CustomAppDefinitionSchema.safeParse(example).success).toBe(false);
  });

  test("accepts bounded server availability and rejects legacy presentation conditions", () => {
    const example = CustomAppDefinitionSchema.parse(structuredClone(CUSTOM_APP_REFERENCE.example));
    const detail = example.pages[1]!;
    const recordBlock = detail.rows[0]!.columns[0]!.blocks.find((block) => block.type === "record")!;
    recordBlock.availableWhen = { query: "from table Requests\nwhere id = @params.request_id\nlimit 1" };
    expect(CustomAppDefinitionSchema.safeParse(example).success).toBe(true);
    example.pages[0]!.availableWhen = { query: "from table Requests\nwhere created_by = @auth.id\nlimit 1" };
    expect(CustomAppDefinitionSchema.safeParse(example).success).toBe(true);

    const legacy = structuredClone(example) as unknown as { pages: Array<{ visibleWhen?: unknown }> };
    legacy.pages[0]!.visibleWhen = [];
    expect(CustomAppDefinitionSchema.safeParse(legacy).success).toBe(false);
  });

  test("rejects unbound, visible, or mismatched record pages and incomplete row navigation", () => {
    const example = CUSTOM_APP_REFERENCE.example;
    const detail = example.pages[1];

    const visible = {
      ...example,
      pages: [example.pages[0], { ...detail, navigation: { ...detail.navigation, visible: true } }],
    };
    expect(CustomAppDefinitionSchema.safeParse(visible).success).toBe(false);

    const mismatched = {
      ...example,
      pages: [example.pages[0], { ...detail, record: { ...detail.record, tableId: uuid(99) } }],
    };
    expect(CustomAppDefinitionSchema.safeParse(mismatched).success).toBe(false);

    const { record: _record, ...detailWithoutRecord } = detail;
    const unbound = { ...example, pages: [example.pages[0], detailWithoutRecord] };
    expect(CustomAppDefinitionSchema.safeParse(unbound).success).toBe(false);

    const recordWithoutBlock = {
      ...example,
      pages: [
        example.pages[0],
        {
          ...detail,
          rows: [
            {
              ...detail.rows[0],
              columns: [{ ...detail.rows[0].columns[0], blocks: [{ id: "copy", type: "markdown", markdown: "Hello" }] }],
            },
          ],
        },
      ],
    };
    expect(CustomAppDefinitionSchema.safeParse(recordWithoutBlock).success).toBe(false);

    const home = example.pages[0];
    const column = home.rows[0].columns[0];
    const requests = column.blocks.find((block) => block.type === "records")!;
    const missingParam = {
      ...example,
      pages: [
        {
          ...home,
          rows: [
            {
              ...home.rows[0],
              columns: [
                {
                  ...column,
                  blocks: column.blocks.map((block) =>
                    block.id === requests.id ? { ...requests, rowNavigate: { ...requests.rowNavigate, params: {} } } : block,
                  ),
                },
              ],
            },
          ],
        },
        detail,
      ],
    };
    expect(CustomAppDefinitionSchema.safeParse(missingParam).success).toBe(false);
    expect(detail.parameters.request_id.type).toBe("record");
  });

  test("accepts Form create-to-detail navigation and rejects undeclared parameter bindings", () => {
    const example = CustomAppDefinitionSchema.parse(structuredClone(CUSTOM_APP_REFERENCE.example));
    expect(CustomAppDefinitionSchema.safeParse(example).success).toBe(true);

    const invalid = CustomAppDefinitionSchema.parse(structuredClone(example));
    const form = invalid.pages[0]!.rows[0]!.columns[0]!.blocks.find((block) => block.type === "form")!;
    if (form.type !== "form") throw new Error("Expected Form block");
    form.fixedValues[uuid(21)] = { source: "PARAMS", path: "missing" };
    expect(CustomAppDefinitionSchema.safeParse(invalid).success).toBe(false);
  });

  test("requires Comments blocks to inherit one declared page record", () => {
    expect(CustomAppCommentsBlockSchema.safeParse({ id: "discussion", type: "comments", emptyText: "No comments" }).success).toBe(false);
    const source = definition();
    const page = source.pages[0]!;
    const row = page.rows[0]!;
    const column = row.columns[0]!;
    const withoutRecord = {
      ...source,
      pages: [
        { ...page, rows: [{ ...row, columns: [{ ...column, blocks: [...column.blocks, { id: "discussion", type: "comments" }] }] }] },
      ],
    };
    expect(CustomAppDefinitionSchema.safeParse(withoutRecord).success).toBe(false);

    const example = CustomAppDefinitionSchema.parse(structuredClone(CUSTOM_APP_REFERENCE.example));
    const detail = example.pages.find((page) => page.record);
    expect(detail?.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks)).some((block) => block.type === "comments")).toBe(
      true,
    );
    expect(CustomAppDefinitionSchema.safeParse(example).success).toBe(true);
  });

  test("accepts typed navigation and workflow actions and rejects ambiguous bindings", () => {
    const example = CustomAppDefinitionSchema.parse(structuredClone(CUSTOM_APP_REFERENCE.example));
    const detail = example.pages[1]!;
    detail.rows[0]!.columns[0]!.blocks.push({
      id: "actions",
      type: "actions",
      actions: [
        {
          id: "reload-detail",
          label: "Open request",
          kind: "navigate",
          pageId: "request",
          history: "replace",
          params: { request_id: { source: "RECORD", path: "id" } },
        },
        {
          id: "approve",
          label: "Approve",
          kind: "workflow",
          launcherId: "LCH090",
          inputs: {
            request: { source: "RECORD", path: "id" },
            reason: { source: "LITERAL", value: "approved" },
          },
          confirm: "Approve this request?",
        },
      ],
    });
    expect(CustomAppDefinitionSchema.safeParse(example).success).toBe(true);

    const duplicateAction = structuredClone(example);
    const duplicateBlock = duplicateAction.pages[1]!.rows[0]!.columns[0]!.blocks.at(-1)!;
    if (duplicateBlock.type !== "actions") throw new Error("Expected Actions block");
    duplicateBlock.actions[1]!.id = duplicateBlock.actions[0]!.id;
    expect(CustomAppDefinitionSchema.safeParse(duplicateAction).success).toBe(false);

    const missingRecord = structuredClone(example);
    delete missingRecord.pages[1]!.record;
    expect(CustomAppDefinitionSchema.safeParse(missingRecord).success).toBe(false);
  });

  test("supports plural row workflows with accessible icon-only actions", () => {
    const source = CustomAppDefinitionSchema.parse(definition());
    const records = source.pages[0]!.rows[0]!.columns[1]!.blocks[0]!;
    if (records.type !== "records") throw new Error("Expected Records block");
    records.rowActions = [
      {
        id: "reserve",
        label: "Reserve item",
        icon: "calendar-plus",
        showLabel: false,
        kind: "workflow",
        launcherId: "LCH090",
        inputs: { item: { source: "ROW", path: "id" }, reason: { source: "LITERAL", value: "loan" } },
      },
      {
        id: "inspect",
        label: "Inspect item",
        showLabel: true,
        kind: "workflow",
        launcherId: "LCH091",
        inputs: {},
      },
    ];
    expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(true);

    const noAccessibleIcon = structuredClone(source);
    const invalidRecords = noAccessibleIcon.pages[0]!.rows[0]!.columns[1]!.blocks[0]!;
    if (invalidRecords.type !== "records") throw new Error("Expected Records block");
    delete invalidRecords.rowActions?.[0]!.icon;
    expect(CustomAppDefinitionSchema.safeParse(noAccessibleIcon).success).toBe(false);
  });

  test("rejects removed v3 Bulk actions", () => {
    const source = structuredClone(definition()) as Record<string, unknown>;
    const pages = source.pages as Array<{ rows: Array<{ columns: Array<{ blocks: Array<Record<string, unknown>> }> }> }>;
    pages[0]!.rows[0]!.columns[1]!.blocks[0]!.bulkActions = [{ id: "approve", label: "Approve selected", launcherId: uuid(92) }];
    expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(false);
  });

  test("accepts bounded Metrics and Chart sources", () => {
    const source = definition();
    source.pages[0]!.rows[0]!.columns[0]!.blocks.push(
      {
        id: "totals",
        type: "metrics",
        source: { kind: "gql", query: 'from table "Requests"\naggregate count(*) as requests' },
      } as never,
      {
        id: "requests-by-state",
        type: "chart",
        chartType: "bar",
        source: { kind: "view", viewId: "VIEW05" },
        limit: 20,
      } as never,
    );

    const parsed = CustomAppDefinitionSchema.safeParse(source);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const chart = parsed.data.pages[0]!.rows[0]!.columns[0]!.blocks.find((block) => block.type === "chart");
      expect(chart?.limit).toBe(20);
    }
  });

  test("rejects legacy explicit GQL inputs", () => {
    const source = definition();
    source.pages[0]!.rows[0]!.columns[0]!.blocks.push({
      id: "children",
      type: "records",
      searchable: true,
      pageSize: 25,
      source: {
        kind: "gql",
        query: "from table Children\nwhere Parent = @params.parent_id",
        inputs: { parent_id: { source: "PARAMS", path: "missing" } },
      },
      display: { kind: "table", columnIds: [uuid(20)] },
    } as never);
    expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(false);
  });

  test("uses type-specific insight bounds without an author-facing maxRows", () => {
    const source = definition();
    source.pages[0]!.rows[0]!.columns[0]!.blocks.push({
      id: "totals",
      type: "metrics",
      source: { kind: "gql", query: 'from table "Requests"\naggregate count(*) as requests' },
    } as never);
    expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(true);

    const legacy = structuredClone(source);
    const legacyMetric = legacy.pages[0]!.rows[0]!.columns[0]!.blocks.at(-1)!;
    if (legacyMetric.type !== "metrics" || !("source" in legacyMetric)) throw new Error("Expected Metrics block");
    (legacyMetric.source as never) = { ...legacyMetric.source, maxRows: 1 } as never;
    expect(CustomAppDefinitionSchema.safeParse(legacy).success).toBe(false);

    const oversized = definition();
    oversized.pages[0]!.rows[0]!.columns[0]!.blocks.push({
      id: "requests-by-state",
      type: "chart",
      chartType: "line",
      source: { kind: "gql", query: 'from table "Requests"\ngroup by Status\naggregate count(*) as requests' },
      limit: 101,
    } as never);
    expect(CustomAppDefinitionSchema.safeParse(oversized).success).toBe(false);
  });
});
