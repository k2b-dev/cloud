import { expect, test } from "bun:test";
import { fromJSON } from "seroval";
import { type ComponentProps, createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../_components/ssr-test-plugin";

const { LocaleProvider } = await import("@k2b/ui");
const { CustomAppPage } = await import("./page");
const { default: CustomAppChart } = await import("./Chart");
const timestamp = "2026-09-17T12:00:00.000Z";

const fixture = (): ComponentProps<typeof CustomAppPage> => {
  const page = {
    id: "detail",
    title: "Detail",
    navigation: { visible: true },
    parameters: {},
    rows: [
      {
        id: "main",
        columns: [
          {
            id: "body",
            span: 12,
            blocks: [
              {
                id: "identity",
                type: "record" as const,
                fieldIds: [],
                editableFieldIds: [],
                documents: { templateIds: ["DOC001"], preview: false },
              },
              { id: "issue", type: "actions" as const, actions: [] },
            ],
          },
        ],
      },
    ],
  };
  return {
    definition: {
      schemaVersion: 5,
      kind: "grids.custom-app",
      id: "APP001",
      baseId: "BASE01",
      name: "Demo",
      startPageId: "detail",
      pages: [page],
    },
    page,
    shortId: "APP001",
    results: new Map(),
    metrics: new Map(),
    charts: new Map(),
    forms: new Map(),
    commentEndpoints: new Map(),
    rowActions: new Map(),
    recordEndpoints: new Map(),
    recordUpdateEndpoints: new Map(),
    documentPreviews: new Map(),
    renderedHtml: new Map(),
    dateConfig: { timeZone: "UTC" },
    markdownContext: {
      "auth.id": null,
      "auth.name": null,
      "auth.username": null,
      "auth.email": null,
      "auth.subjects": [],
      "page.id": "detail",
      "page.title": "Detail",
      "page.url": "/apps/APP001/detail",
      "app.id": "APP001",
      "app.name": "Demo",
      "base.id": "BASE01",
      "base.name": "Demo",
      "time.now": timestamp,
      "time.today": "2026-09-17",
      "time.timeZone": "UTC",
    },
    scanners: new Map(),
    sidebarActions: [],
    signedIn: true,
    pageRecords: new Map([
      [
        "identity",
        {
          tableName: "Invoices",
          auditPolicy: {},
          fields: [],
          relationLabels: {},
          fileEndpoints: {},
          filesByField: {},
          record: {
            id: "REC001",
            tableId: "TABLE1",
            data: {},
            version: 1,
            deletedAt: null,
            createdBy: null,
            updatedBy: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
      ],
    ]),
    documents: new Map([
      [
        "identity",
        [
          {
            id: "PDF001",
            baseId: "BASE01",
            tableId: "TABLE1",
            recordId: "REC001",
            templateId: "DOC001",
            workflowId: null,
            workflowRunId: null,
            number: "RE-001",
            filename: "RE-001.pdf",
            createdAt: timestamp,
            createdBy: null,
            tags: [],
            renderer: { kind: "html" },
            validationStatus: null,
            primaryArtifactKey: "pdf",
            artifacts: [],
            sourceRecordCount: 1,
            dataSnapshot: null,
            downloadUrl: "/record-document.pdf",
          },
        ],
      ],
    ]),
    actions: new Map([
      [
        "issue",
        [
          {
            id: "issue",
            kind: "workflow",
            launcherId: "ISSUE1",
            label: "Issue invoice",
            endpoint: "/issue",
            background: {
              acceptedMessage: "Creation requested",
              state: {
                status: "ready",
                document: { id: "PDF001", number: "RE-001", blockId: "identity" },
                downloadUrl: "/ready-document.pdf",
              },
            },
          },
        ],
      ],
    ]),
  };
};

test("ready action yields to the matching readable document, retaining its fallback otherwise", () => {
  const input = fixture();
  const render = () => renderToString(() => createComponent(CustomAppPage, input));
  expect(render()).toContain("/record-document.pdf");
  expect(render()).not.toContain("/ready-document.pdf");
  input.documents.clear();
  expect(render()).toContain("/ready-document.pdf");
  input.documents = fixture().documents;
  input.documents.get("identity")![0]!.id = "PDF002";
  expect(render()).toContain("/ready-document.pdf");
  input.documents = fixture().documents;
  input.pageRecords.clear();
  expect(render()).toContain("/ready-document.pdf");
});

test("an older displayed document never conceals running work or recovery", () => {
  const input = fixture();
  const action = input.actions.get("issue")![0]!;
  if (action.kind !== "workflow" || !action.background) throw new Error("Missing fixture action");
  for (const status of ["running", "failed", "missing", "attention"] as const) {
    action.background.state = { status };
    const html = renderToString(() => createComponent(CustomAppPage, input));
    expect(html).toContain("/record-document.pdf");
    expect(html).toContain(status === "running" ? "Creation requested" : status === "attention" ? 'role="alert"' : "<button");
  }
});

test("a Markdown block names untitled info blocks in the page language", () => {
  const input = fixture();
  input.page.rows[0]!.columns[0]!.blocks = [{ id: "intro", type: "markdown", markdown: ":::warning\nErst sichern.\n:::" }];
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(CustomAppPage, input);
      },
    }),
  );
  expect(html).toContain('<span class="k2b-sr-only">Warnung: </span>');
});

test("a chart block keeps its subtitle above a fixed-height chart and shows its axis labels", () => {
  const input = fixture();
  input.page.rows[0]!.columns[0]!.blocks = [
    {
      id: "tickets",
      type: "chart",
      chartType: "bar",
      source: { kind: "view", viewId: "VIEW01" },
      limit: 100,
      subtitle: "Open tickets by status",
      xAxisLabel: "Status",
      yAxisLabel: "Tickets",
    },
  ];
  input.charts.set("tickets", {
    ok: true,
    chart: {
      kind: "chart",
      buckets: [
        { keys: ["New"], values: { "*__count": 4 } },
        { keys: ["Done"], values: { "*__count": 9 } },
      ],
      fields: [],
      viewQuery: { groupBy: [{ fieldId: "status" }], aggregations: [{ fieldId: "*", agg: "count" }] },
      relationLabels: {},
    },
  });
  const html = renderToString(() => createComponent(CustomAppPage, input));
  // The subtitle must not eat into the chart's height, or the chart spills over the next block.
  expect(html).toMatch(
    /<p class="mb-3 text-sm text-secondary">Open tickets by status<\/p><solid-island data-id="[^"]+"[^>]*><div class="flex h-72 flex-col">/,
  );
  expect(html).toMatch(/<p[^>]*data-chart-y-axis-label[^>]*>Tickets<\/p>/);
  expect(html).toMatch(/<p[^>]*data-chart-x-axis-label[^>]*>Status<\/p>/);
});

test("signed-in and anonymous chart blocks serialize only display data and preserve their server SVG", async () => {
  for (const signedIn of [true, false]) {
    const input = fixture();
    input.signedIn = signedIn;
    const fieldId = "FIELDSECRET1";
    const relationId = "a64d7c8a-9fc4-4836-a75e-2ee931491020";
    const data: Extract<ComponentProps<typeof CustomAppChart>["data"], { kind: "chart" }> = {
      kind: "chart",
      fields: [
        {
          id: fieldId,
          tableId: "TABLE1",
          name: "Internal metadata",
          type: "number",
          config: {},
          required: false,
          position: 0,
          presentable: false,
          hideInTable: false,
          indexed: false,
          uniqueConstraint: false,
          defaultValue: null,
          description: null,
          deletedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      buckets: [
        { keys: ["Neu"], values: { [`${fieldId}__sum`]: 4 } },
        { keys: [relationId], values: { [`${fieldId}__sum`]: 9 } },
      ],
      viewQuery: { groupBy: [{ fieldId: "RELATIONSECRET1" }], aggregations: [{ fieldId, agg: "sum", label: "Umsatz" }] },
      relationLabels: { [relationId]: "Kundendienst" },
    };
    const chartTypes = ["bar", "line", "donut"] as const;
    input.page.rows[0]!.columns[0]!.blocks = chartTypes.map((chartType) => ({
      id: chartType,
      type: "chart",
      chartType,
      source: { kind: "view", viewId: "VIEWSECRET1" },
      limit: 100,
    }));
    for (const kind of chartTypes) input.charts.set(kind, { ok: true, chart: data });
    const html = renderToString(() => createComponent(CustomAppPage, input));
    const islands: { id: string | null; file: string | null; props: string | null }[] = [];
    await new HTMLRewriter()
      .on("solid-island", {
        element(element) {
          if (element.getAttribute("data-file") === "Chart.island.tsx") {
            islands.push({
              id: element.getAttribute("data-id"),
              file: element.getAttribute("data-file"),
              props: element.getAttribute("data-props"),
            });
          }
        },
      })
      .transform(new Response(html))
      .text();
    expect(islands).toHaveLength(3);
    expect(new Set(islands.map((island) => island.id)).size).toBe(1);
    const chartBodies = [...html.matchAll(/<solid-island\b[^>]*>([\s\S]*?)<\/solid-island>/g)]
      .map((match) => match[1]!)
      .filter((body) => body.includes("data-chart-kind="));
    expect(chartBodies).toHaveLength(3);
    for (const [index, chartType] of chartTypes.entries()) {
      const island = islands[index]!;
      expect(island.id).toMatch(/^[a-f0-9]{12}$/);
      expect(island.file).toBe("Chart.island.tsx");
      const props: unknown = fromJSON(
        JSON.parse(island.props!.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")),
      );
      const decoded = JSON.stringify(props);
      expect(decoded).toContain('"kind":"' + chartType + '"');
      for (const label of ["Neu", "Kundendienst", "Umsatz"]) expect(decoded).toContain(label);
      for (const secret of [fieldId, relationId, "RELATIONSECRET1", "VIEWSECRET1", "Internal metadata"])
        expect(decoded).not.toContain(secret);
      for (const key of ["fields", "buckets", "relationLabels", "viewQuery"]) expect(decoded).not.toContain(`"${key}":`);
      const original = renderToString(() => createComponent(CustomAppChart, { chartType, data, dateConfig: input.dateConfig }));
      expect(chartBodies[index]!.match(/<svg\b[\s\S]*?<\/svg>/)?.[0]).toBe(original.match(/<svg\b[\s\S]*?<\/svg>/)?.[0]);
    }
  }
});

test("an error chart keeps its subtitle and unavailable placeholder without a chart island", () => {
  const input = fixture();
  input.page.rows[0]!.columns[0]!.blocks = [
    {
      id: "failed",
      type: "chart",
      chartType: "bar",
      source: { kind: "view", viewId: "VIEW01" },
      limit: 100,
      subtitle: "Chart subtitle",
    },
  ];
  input.charts.set("failed", { ok: true, chart: { kind: "error", reason: "x" } });
  const html = renderToString(() => createComponent(CustomAppPage, input));
  expect(html).toContain("Chart subtitle");
  expect(html).toContain("Chart data is unavailable.");
  expect(html).not.toContain("Chart.island.tsx");
  expect(html).not.toContain("data-chart-kind");
});
