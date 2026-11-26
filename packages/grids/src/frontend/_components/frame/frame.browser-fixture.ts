/**
 * Invented data for the v2 frame's browser tests: the bases overview and a base home in three states. `plain` is a
 * small team's Grids, `worst` the break-ui catalogue (long and unbreakable names, one letter, non-Latin, emoji,
 * missing descriptions, huge counts), `huge` a Grids with 1,000 bases and a base with 1,000 tables.
 */
import type { PublicDslQueryPreviewResponse } from "../../../api/gql-public";
import type { PublicBase, PublicTable, PublicView } from "../../../api/public-dto";
import type DocumentTemplateScreen from "../documents/DocumentTemplateScreen";
import { parseTemplateDocumentsState } from "../documents/DocumentTemplateScreen";
import { documentCatalogIsFlat, parseDocumentCatalogUrlState } from "../documents/document-catalog-url-state";
import type { BasesOverviewProps } from "../overview/BasesOverview";
import type QueryScreen from "../query/QueryScreen";
import type QueryViewScreen from "../query/QueryViewScreen";
import { recordsFilterStatements } from "../records-view/filter-statements";
import { parseRecordsState } from "../records-view/query-url";
import type RecordsView from "../records-view/RecordsView";
import { fields as tableFields, records as tableRecords } from "../table/database-table.fixture-data";
import type WorkflowScreen from "../workflows/WorkflowScreen";
import { parseWorkflowUrlState } from "../workflows/workflow-url-state";
import type { NavigationState } from "../workspace/navigation-catalog";
import type { PublicOkWorkspaceState } from "../workspace/workspace-public-state-model";

/** Plain data, the break-ui worst case, 1,000 entries, none at all, and exactly one (singular words). */
export type FixtureVariant = "plain" | "worst" | "huge" | "empty" | "one";

/** How many entries a list holds in a variant: none, one, or what the variant would have. */
const sized = (variant: FixtureVariant, count: number) => (variant === "empty" ? 0 : variant === "one" ? Math.min(1, count) : count);

export const FIXTURE_REVISION = { revision: "r1", resources: { "base:Bas001": "b1" } };
export const FIXTURE_NOW = "2026-11-25T09:00:00.000Z";
const minutesAgo = (minutes: number) => new Date(Date.parse(FIXTURE_NOW) - minutes * 60_000).toISOString();
const DATE_CONFIG = { locale: "de", timeZone: "Europe/Berlin", firstDayOfWeek: 1 } as const;

const base = (id: string, name: string, description: string | null): PublicBase => ({
  id,
  name,
  description,
  documentDefaults: {},
  createdBy: null,
  deletedAt: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
});

const PLAIN_BASES = [
  base("Bas001", "Werkstatt", "Aufträge, Ersatzteile und Termine"),
  base("Bas002", "Lager Nord", "Bestand und Einlieferungen"),
  base("Bas003", "Kunden", null),
  base("Bas004", "Personal", "Urlaub, Schichten und Schulungen"),
];

const WORST_BASES = [
  base("Bas101", "Ersatzteilverwaltung-und-Reparaturdokumentation-der-Werkstatt-Nordhausen-Ost-2026", null),
  base("Bas102", "X", "Y"),
  base("Bas103", "物流センター東京 – 在庫と出荷", "倉庫ごとの在庫数、入荷、出荷予定を一つの表で管理します。"),
  base("Bas104", "🚚 Fuhrpark 🔧", "Fahrzeuge, TÜV-Termine, Schäden 💥 und Tankkarten"),
  base(
    "Bas105",
    "Kunden",
    "Eine sehr lange Beschreibung, die erklärt, welche Kunden, Ansprechpersonen, Verträge, Zahlungsbedingungen, Mahnstufen und Sonderabsprachen hier stehen und warum.",
  ),
  base("Bas106", "Sozialversicherungsfachangestelltenausbildungsunterlagen", "unbreakable@a-very-long-domain-name-for-testing.example"),
];

const hugeBases = (offset: number) =>
  Array.from({ length: 100 }, (_, index) => {
    const n = offset + index + 1;
    return base(`H${String(n).padStart(5, "0")}`, `Base ${n}`, n % 3 === 0 ? null : `Bereich ${n % 17} · Standort ${n % 9}`);
  });

const TEMPLATES: BasesOverviewProps["templates"] = [
  {
    id: "inventory",
    name: "Inventar",
    description: "Geräte, Ausleihen und Rückgaben",
    icon: "ti ti-package",
    highlights: ["Tabellen für Geräte und Ausleihen", "Formular zur Ausleihe", "App für die Ausgabe"],
  },
  {
    id: "crm",
    name: "CRM",
    description: "Kunden, Kontakte und Angebote",
    icon: "ti ti-address-book",
    highlights: ["Kunden und Kontakte", "Angebote mit Status", "Workflow für Wiedervorlagen"],
  },
];

const stats = (bases: PublicBase[], large = false) =>
  Object.fromEntries(
    bases.map((each, index) => [
      each.id,
      { tableCount: large && index === 1 ? 128_345 : (index * 7) % 23, lastActivityAt: minutesAgo(index * 97 + 3) },
    ]),
  );

/** The overview's props for a variant and an address (`q`, `page`, `apps`, `new` are read like the server does). */
export const basesFixture = (variant: FixtureVariant, params: URLSearchParams): Omit<BasesOverviewProps, "state"> => {
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const all = variant === "huge" ? hugeBases((page - 1) * 100) : variant === "worst" ? WORST_BASES : PLAIN_BASES;
  const search = params.get("q")?.trim().toLowerCase();
  const found = search ? all.filter((each) => `${each.name} ${each.description ?? ""}`.toLowerCase().includes(search)) : all;
  const bases = found.slice(0, sized(variant, found.length));
  const apps =
    variant === "plain"
      ? []
      : Array.from({ length: 8 }, (_, index) => ({
          id: `App${index}`,
          name: variant === "worst" && index === 0 ? "Ausgabe-und-Rücknahme-Terminal-für-Leihgeräte-im-Erdgeschoss" : `App ${index + 1}`,
          icon: index % 2 ? "scan" : null,
          baseName: variant === "worst" && index === 1 ? "物流センター東京" : "Lager Nord",
        }));
  return {
    page,
    bases,
    total: search || variant === "empty" || variant === "one" ? bases.length : variant === "huge" ? 1000 : all.length,
    templates: TEMPLATES,
    baseStats: stats(bases, variant === "worst"),
    recentTables: bases.slice(0, 12).map((each, index) => ({
      id: `Tab${index}`,
      baseId: each.id,
      baseName: each.name,
      name: variant === "worst" && index === 0 ? "Wartungsprotokolle-der-Hebebühnen-und-Druckluftanlagen" : `Tabelle ${index + 1}`,
      icon: null,
      lastActivityAt: minutesAgo(index * 41 + 1),
    })),
    apps: { items: apps, total: variant === "worst" ? 12_480 : apps.length, page: params.get("apps") ? Number(params.get("apps")) : null },
    create: params.get("new"),
    dateConfig: DATE_CONFIG,
  };
};

const table = (id: string, name: string, icon: string | null = null): PublicTable => ({
  id,
  baseId: "Bas001",
  name,
  description: null,
  icon,
  kind: "stored",
  columns: [],
  displayConfig: { mode: "table" },
  auditPolicy: {},
  mutationPolicy: { mode: "all" },
  position: 0,
  disableDirectInsert: false,
  createdAt: "2026-09-09T00:00:00Z",
  updatedAt: "2026-09-09T00:00:00Z",
  deletedAt: null,
});

const tablesOf = (variant: FixtureVariant): PublicTable[] => {
  if (variant === "huge")
    return Array.from({ length: 1000 }, (_, index) => table(`T${String(index).padStart(5, "0")}`, `Tabelle ${index + 1}`));
  if (variant === "worst")
    return [
      table("T1", "Wartungsprotokolle-der-Hebebühnen-und-Druckluftanlagen-im-Werk-Süd"),
      table("T2", "A"),
      table("T3", "在庫 · 東京倉庫", "ti ti-package"),
      table("T4", "📦 Pakete 🚀"),
    ];
  return [
    table("T1", "Aufträge", "ti ti-clipboard-list"),
    table("T2", "Ersatzteile", "ti ti-package"),
    table("T3", "Termine", "ti ti-calendar"),
  ];
};

/** A base home's workspace state for a variant; `edit` turns edit mode on, `groups` adds curated groups. */
export const baseHomeFixture = (variant: FixtureVariant, options: { edit: boolean; groups: boolean }): PublicOkWorkspaceState => {
  const tables = tablesOf(variant);
  const first = tables[0]!;
  return {
    kind: "ok",
    base: {
      ...base(
        "Bas001",
        variant === "worst" ? "Ersatzteilverwaltung-und-Reparaturdokumentation-Nordhausen" : "Werkstatt",
        "Aufträge, Ersatzteile und Termine der Werkstatt",
      ),
    },
    title: [{ title: "Werkstatt" }],
    rememberPath: "/app/grids/Bas001",
    adminModeRequested: options.edit,
    editModeToggleHref: options.edit ? "/app/grids/Bas001" : "/app/grids/Bas001?edit=true",
    canManageBase: true,
    canCreateTables: true,
    canUseEditMode: true,
    canUseQueryWorkspace: true,
    liveCursor: null,
    workspaceRevision: FIXTURE_REVISION,
    navigation: {
      revision: 1,
      groups: options.groups
        ? [
            {
              id: "G1",
              name: "Annahme",
              entries: [
                { type: "table", id: first.id },
                { type: "form", id: "F1" },
              ],
            },
            { id: "G2", name: variant === "worst" ? "Auswertungen-und-Berichte-für-die-Geschäftsführung-2026" : "Auswertung", entries: [] },
          ]
        : [],
    },
    route: { kind: "overview" },
    catalog: {
      customApps: [
        { id: "A1", name: "Annahme-Terminal", icon: "scan", publishedAt: null },
      ] as unknown as PublicOkWorkspaceState["catalog"]["customApps"],
      workflows: [
        { id: "W1", name: "Rechnung stellen", enabled: true },
        { id: "W2", name: "Erinnerung", enabled: false },
      ] as unknown as PublicOkWorkspaceState["catalog"]["workflows"],
      workflowLaunchers: [],
      workflowLevels: {},
      tables,
      tableLevels: Object.fromEntries(tables.map((each) => [each.id, "admin"])),
      fieldsByTable: {},
      viewsByTable: {
        [first.id]: [
          { id: "V1", tableId: first.id, name: "Offene Aufträge", icon: null },
          {
            id: "V2",
            tableId: first.id,
            name: variant === "worst" ? "Überfällige-Aufträge-mit-fehlenden-Ersatzteilen" : "Diese Woche",
            icon: null,
          },
        ] as unknown as PublicOkWorkspaceState["catalog"]["viewsByTable"][string],
      },
      formsByTable: {},
      documentTemplatesByTable: {},
      documentTemplateLevels: {},
      sidebarForms: [
        { form: { id: "F1", tableId: first.id, name: "Auftrag annehmen" }, table: first },
      ] as unknown as PublicOkWorkspaceState["catalog"]["sidebarForms"],
      sidebarDocumentTemplates: [
        { template: { id: "D1", name: "Rechnung" }, table: first },
      ] as unknown as PublicOkWorkspaceState["catalog"]["sidebarDocumentTemplates"],
    },
  } as unknown as PublicOkWorkspaceState;
};

/** The records page of a table for a variant and an address, as the server renders it (`record`, `sort`, `q` …). */
export const recordsFixture = (variant: FixtureVariant, params: URLSearchParams): Parameters<typeof RecordsView>[0] => {
  // the server reads a table page's statements with the table's fields
  const state = parseRecordsState(params, recordsFilterStatements(tableFields, "de"));
  const items =
    variant === "huge"
      ? Array.from({ length: 1000 }, (_, index) => ({
          ...tableRecords[0]!,
          id: `record-${index}`,
          data: { ...tableRecords[0]!.data, text: `Auftrag ${index + 1}` },
        }))
      : variant === "worst"
        ? tableRecords.map((record, index) => ({
            ...record,
            data: {
              ...record.data,
              text:
                index === 0
                  ? "Wartungsprotokolle-der-Hebebühnen-und-Druckluftanlagen-im-Werk-Süd-2026"
                  : index === 1
                    ? "X"
                    : `物流センター東京 ${index}`,
              customer: index === 2 ? "🚚 Spedition 💥" : index === 4 ? null : record.data.customer,
              number: index === 3 ? "987654321.99" : index === 4 ? null : record.data.number,
              date: index === 4 ? null : record.data.date,
              contact: index === 5 ? "bartholomew.fitzgerald@northwind-industries-holdings.example.com" : record.data.contact,
              place:
                index === 6
                  ? "https://werkstatt.example.org/standorte/nordhausen/halle-3/regal-17/fach-4?ansicht=karte"
                  : record.data.place,
              notes: "Eine sehr lange Notiz, die erklärt, welche Absprachen getroffen wurden und warum die Lieferung später kommt.",
            },
          }))
        : tableRecords.slice(0, sized(variant, tableRecords.length));
  const frame = baseHomeFixture(variant, { edit: params.get("edit") === "true", groups: false });
  return {
    frame: { ...frame, route: { kind: "records", activeKey: "table:table", activeTableId: "table" } },
    revision: FIXTURE_REVISION,
    baseId: "Bas001",
    tableId: "table",
    tableKind: "stored",
    tableName: "Aufträge",
    tableDescription: null,
    tableIcon: "ti ti-clipboard-list",
    tableColumns: [],
    tableUpdatedAt: FIXTURE_NOW,
    tableAuditPolicy: {},
    tableMutationPolicy: { mode: "all" },
    disableDirectInsert: false,
    viewId: null,
    fields: tableFields,
    tables: [],
    viewsByTable: {
      table: [
        { id: "V1", tableId: "table", name: "Offene Aufträge", icon: null },
        { id: "V2", tableId: "table", name: "Diese Woche", icon: null },
      ] as unknown as Parameters<typeof RecordsView>[0]["viewsByTable"][string],
    },
    forms: [],
    canReadTable: true,
    canWrite: true,
    canManageTable: true,
    canManageBase: true,
    trashMode: false,
    initialAdminMode: params.get("edit") === "true",
    otherTables: [{ id: "table", name: "Aufträge" }],
    fieldsByTable: { table: tableFields },
    viewMode: false,
    initialState: { ...state, selectedRecordId: null },
    initialData: { items, nextCursor: variant === "plain" ? "next-page" : null },
    initialError: null,
    // a page renders with its live cursor, so it does not read its records again at once
    initialEventCursor: "cursor-1",
    initialSelectedRecord: null,
    initialSelectedRecordDetail: null,
    documentTemplates: [],
    relationLabels: {},
    viewColumns: undefined,
    groupedExplode: false,
    activeRecordQuery: null,
    displayConfig: { mode: "table" },
    bulkSelectionLaunchers: [],
    recordActionLaunchers: [],
    dateConfig: DATE_CONFIG,
    now: FIXTURE_NOW,
    workspaceRouteKey: "records:table::false",
  };
};

const document = (index: number, variant: FixtureVariant) => {
  const worst = variant === "worst";
  const name =
    worst && index === 0
      ? "Rechnung-2026-11-0042-Werkstatt-Nordhausen-Ersatzteile-Druckluftanlage-final-v3.pdf"
      : `Rechnung-2026-${String(index + 1).padStart(4, "0")}.pdf`;
  return {
    id: `D${String(index).padStart(5, "0")}`,
    baseId: "Bas001",
    tableId: null,
    recordId: null,
    templateId: index % 3 === 0 ? null : "TPL001",
    workflowId: index % 3 === 0 ? "WFL001" : null,
    workflowRunId: index % 3 === 0 ? `RUN${index}` : null,
    number: worst && index === 1 ? "物流-請求書-0001" : `R-2026-${index + 1}`,
    filename: name,
    createdAt: minutesAgo(index * 53 + 7),
    tags: [],
    createdBy: null,
    renderer: { kind: "html" as const },
    validationStatus: "valid" as const,
    artifacts: [
      {
        key: "pdf",
        filename: name,
        mimeType: index % 5 === 4 ? "application/zip" : "application/pdf",
        sizeBytes: 48_213 + index,
        sha256: "a".repeat(64),
        downloadUrl: `/api/grids/documents/D${index}/artifacts/pdf`,
      },
    ],
    primaryArtifactKey: "pdf",
    downloadUrl: `/api/grids/documents/D${index}/download`,
    sourceRecordCount: null,
    dataSnapshot: null,
  };
};

/** "All documents" of the fixture base: folders at the start, a list when the address asks for one. */
export const documentsFixture = (variant: FixtureVariant, params: URLSearchParams) => {
  const catalog = parseDocumentCatalogUrlState(params);
  const flat = documentCatalogIsFlat(catalog);
  const count = sized(variant, variant === "huge" ? 1000 : variant === "worst" ? 12 : 18);
  const items = flat || catalog.path.length ? Array.from({ length: count }, (_, index) => document(index, variant)) : [];
  const frame = baseHomeFixture(variant, { edit: false, groups: false });
  return {
    frame: { ...frame, route: { kind: "documents" as const, activeKey: "documentTemplate:all" } },
    revision: FIXTURE_REVISION,
    baseId: "Bas001",
    canWriteDocuments: true,
    documentTemplateLevels: { TPL001: "admin" as const },
    linkableWorkflowIds: ["WFL001"],
    initialCatalog: catalog,
    facets: {
      workflows: [
        { id: "WFL001", name: variant === "worst" ? "Monatsabschluss-und-Export-an-die-Steuerberatung-2026" : "Monatsabschluss" },
      ],
      templates: [{ id: "TPL001", name: "Rechnung" }],
      tables: [{ id: "T1", name: "Aufträge" }],
      mediaTypes: ["application/pdf", "application/zip"],
    },
    initialBrowserPage: {
      items,
      path: catalog.path,
      cursor: null,
      hasMore: false,
      folders: flat
        ? []
        : catalog.path.length === 0
          ? [
              { kind: "template" as const, key: "TPL001", label: "Rechnung", path: ["TPL001"], count: count - 6 },
              { kind: "workflow" as const, key: "workflow:WFL001", label: "Monatsabschluss", path: ["workflow:WFL001"], count: 6 },
            ]
          : [],
    },
    dateConfig: DATE_CONFIG,
  };
};

const ORDERS = table("table", "Aufträge", "ti ti-clipboard-list");
const QUERY_FIELDS = ["text", "status", "customer", "number", "date"] as const;

/** The rows a query over the orders returns: a page of up to 100 of `total`, from `start` on. */
export const queryResultFixture = (variant: FixtureVariant, start = 0): PublicDslQueryPreviewResponse => {
  const total = sized(variant, variant === "huge" ? 1000 : variant === "worst" ? 4 : 10);
  const size = Math.min(100, total - start);
  const worst = (index: number) =>
    index === 0
      ? "Wartungsprotokolle-der-Hebebühnen-und-Druckluftanlagen-im-Werk-Süd-2026"
      : index === 1
        ? "X"
        : index === 2
          ? "物流センター東京"
          : "🚚 Spedition 💥";
  return {
    ok: true,
    mode: "rows",
    limit: 100,
    columns: QUERY_FIELDS.map((id) => {
      const field = tableFields.find((each) => each.id === id)!;
      return { key: id, label: field.name, type: field.type, sqlType: "text", tableId: "table", fieldId: id };
    }),
    rows: Array.from({ length: size }, (_, offset) => {
      const index = start + offset;
      const record = tableRecords[index % tableRecords.length]!;
      return {
        recordId: `record-${index}`,
        values: {
          ...Object.fromEntries(QUERY_FIELDS.map((id) => [id, record.data[id] ?? null])),
          text: variant === "worst" ? worst(index) : `${record.data.text} ${index + 1}`,
          ...(variant === "worst" && index === 3 ? { number: "987654321.99" } : {}),
        },
      };
    }),
    truncated: start + size < total,
    page: { size: 100, start, returned: size, nextCursor: start + size < total ? `cursor-${start + size}` : null },
  };
};

const queryFrame = (variant: FixtureVariant, kind: "query" | "records"): NavigationState => {
  const frame = baseHomeFixture(variant, { edit: false, groups: false });
  const tables = [ORDERS, ...frame.catalog.tables.slice(variant === "huge" ? 0 : 1)];
  return { ...frame, catalog: { ...frame.catalog, tables }, route: { kind, activeKey: kind === "query" ? "query" : "view:V9" } };
};

const queryViews = (variant: FixtureVariant): PublicView[] =>
  [
    { id: "V1", tableId: "table", name: "Offene Aufträge", icon: null },
    {
      id: "V9",
      tableId: "table",
      name: variant === "worst" ? "Umsatz-pro-Monat-nach-Kundengruppe-und-Region-2026" : "Umsatz pro Monat",
      icon: null,
    },
  ] as unknown as PublicView[];

/** The query of the fixture base: the address's `q` stands in the editor, its first page of rows under it. */
export const queryFixture = (variant: FixtureVariant, params: URLSearchParams): Parameters<typeof QueryScreen>[0] => {
  const frame = queryFrame(variant, "query");
  const query = params.get("q") ?? "";
  return {
    frame,
    revision: FIXTURE_REVISION,
    baseId: "Bas001",
    baseName: frame.base.name,
    initialQuery: query,
    initialCursor: null,
    initialPreview: query ? queryResultFixture(variant) : null,
    queryPath: "/app/grids/Bas001/query",
    tables: frame.catalog.tables,
    fieldsByTable: { table: tableFields },
    viewsByTable: { table: queryViews(variant) },
  };
};

/** A saved view that aggregates: revenue by month, as the server renders its first page. */
export const queryViewFixture = (variant: FixtureVariant): Parameters<typeof QueryViewScreen>[0] => {
  const frame = queryFrame(variant, "records");
  const months = sized(variant, variant === "huge" ? 100 : 12);
  const views = queryViews(variant);
  return {
    frame,
    revision: FIXTURE_REVISION,
    baseId: "Bas001",
    table: ORDERS,
    view: views[1]!,
    views,
    fields: tableFields,
    fieldsByTable: { table: tableFields },
    canEditView: true,
    initialCursor: null,
    initialResult: {
      ok: true,
      mode: "groups",
      limit: 100,
      columns: [
        { key: "month", label: "Monat", type: "text", sqlType: "text" },
        { key: "customer", label: "Kunde", type: "text", sqlType: "text", tableId: "table", fieldId: "customer" },
        {
          key: "total",
          label: variant === "worst" ? "Summe-aller-abgerechneten-Beträge-netto" : "Summe",
          type: "aggregate",
          sqlType: "numeric",
          aggregate: "sum",
        },
        { key: "count", label: "Aufträge", type: "aggregate", sqlType: "integer", aggregate: "count" },
      ],
      rows: Array.from({ length: months }, (_, index) => ({
        values: {
          month: `2026-${String((index % 12) + 1).padStart(2, "0")}`,
          customer: variant === "worst" && index === 0 ? "Bäckerei-Sonnenkorn-Filiale-Nordhausen-Hauptbahnhof" : "Bäckerei Sonnenkorn",
          total: variant === "worst" && index === 1 ? 987654321.99 : 12_400 + index * 310,
          count: 3 + (index % 7),
        },
      })),
      truncated: false,
      page: { size: 100, start: 0, returned: months, nextCursor: variant === "huge" ? "cursor-100" : null },
    },
  };
};

/** The documents of the template "Rechnung": newest first, or by year and month, as the address asks. */
export const templateFixture = (variant: FixtureVariant, params: URLSearchParams): Parameters<typeof DocumentTemplateScreen>[0] => {
  const state = parseTemplateDocumentsState(params, "list");
  const count = sized(variant, variant === "huge" ? 1000 : variant === "worst" ? 12 : 18);
  const all = Array.from({ length: count }, (_, index) => ({
    ...document(index, variant),
    templateId: "TPL001",
    workflowId: null,
    workflowRunId: null,
  }));
  const matching = state.q ? all.filter((each) => each.filename.toLowerCase().includes(state.q.toLowerCase())) : all;
  const [year, month] = state.path;
  const folders =
    state.mode !== "folders" || month
      ? []
      : year
        ? ["11", "10", "09"].map((each, index) => ({
            kind: "month" as const,
            key: each,
            label: each,
            path: [year, each],
            count: [9, 6, 3][index]!,
          }))
        : [{ kind: "year" as const, key: "2026", label: "2026", path: ["2026"], count }];
  const items = folders.length ? [] : matching;
  const frame = baseHomeFixture(variant, { edit: false, groups: false });
  return {
    frame: { ...frame, route: { kind: "documentTemplate", activeKey: "documentTemplate:TPL001" } },
    revision: FIXTURE_REVISION,
    baseId: "Bas001",
    table: ORDERS,
    template: {
      id: "TPL001",
      tableId: "table",
      name: variant === "worst" ? "Rechnung-mit-Leistungsnachweis-und-Zahlungsplan-für-Großkunden" : "Rechnung",
      description: null,
      enabled: true,
      position: 0,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
    } as unknown as Parameters<typeof DocumentTemplateScreen>[0]["template"],
    editableTemplate: null,
    canWriteTemplate: true,
    initialRecordId: null,
    initialState: state,
    initialBrowserPage: { items, path: state.path, cursor: null, hasMore: false, folders },
    dateConfig: DATE_CONFIG,
  };
};

type WorkflowRunFixture = Parameters<typeof WorkflowScreen>[0]["initialOverview"]["runs"]["items"][number];
const RUN_STATES: WorkflowRunFixture["status"][] = [
  "succeeded",
  "succeeded",
  "failed",
  "succeeded",
  "running",
  "needs_attention",
  "succeeded",
];
const RUN_CHANNELS: WorkflowRunFixture["channel"][] = ["record", "schedule", "api", "bulk", "scanner"];

const workflowRun = (index: number, variant: FixtureVariant): WorkflowRunFixture => {
  const status = RUN_STATES[index % RUN_STATES.length]!;
  const created = minutesAgo(index * 37 + 3);
  return {
    id: `RUN${String(index).padStart(5, "0")}`,
    workflowId: "W1",
    launcherId: null,
    baseId: "Bas001",
    workflowRevision: 7,
    mode: index % 9 === 4 ? "dryRun" : "execute",
    channel: RUN_CHANNELS[index % RUN_CHANNELS.length]!,
    actorUserId: null,
    serviceAccountId: null,
    inputs: {},
    status,
    result: null,
    error:
      status === "failed"
        ? {
            code: "workflow.step_failed",
            retryable: false,
            message:
              variant === "worst"
                ? "Die Rechnung konnte nicht erzeugt werden, weil der Kunde Bäckerei-Sonnenkorn-Filiale-Nordhausen-Hauptbahnhof keine Steuernummer hat"
                : "Kunde ohne Steuernummer",
          }
        : null,
    resultMessage: status === "succeeded" ? `Rechnung R-2026-${String(1000 - index).padStart(4, "0")} erzeugt` : null,
    createdAt: created,
    startedAt: status === "queued" ? null : created,
    finishedAt: status === "running" ? null : new Date(Date.parse(created) + 2_400 + index * 90).toISOString(),
  };
};

/** The workflow "Rechnung stellen" with its runs; `?run=` opens one, `?status=` and `?channel=` filter them. */
export const workflowFixture = (variant: FixtureVariant, params: URLSearchParams): Parameters<typeof WorkflowScreen>[0] => {
  const filters = parseWorkflowUrlState(params);
  const count = sized(variant, variant === "huge" ? 1000 : variant === "worst" ? 9 : 24);
  const runs = Array.from({ length: count }, (_, index) => workflowRun(index, variant)).filter(
    (run) => (filters.status === "all" || run.status === filters.status) && (filters.channel === "all" || run.channel === filters.channel),
  );
  const frame = baseHomeFixture(variant, { edit: false, groups: false });
  const selected = params.get("run");
  const selectedRun = runs.find((run) => run.id === selected) ?? null;
  const workflow = {
    id: "W1",
    baseId: "Bas001",
    name: variant === "worst" ? "Rechnung-stellen-und-an-Buchhaltung-und-Steuerberatung-übergeben" : "Rechnung stellen",
    description: variant === "worst" ? null : "Erzeugt die Rechnung eines erledigten Auftrags und schickt sie an den Kunden.",
    enabled: true,
    revision: 7,
    plan: { inputs: [], bindings: {}, triggers: [{ kind: "recordEvent" }] },
  } as unknown as Parameters<typeof WorkflowScreen>[0]["workflows"][number];
  const failed = runs.filter((run) => run.status === "failed").length;
  const attention = runs.filter((run) => run.status === "needs_attention").length;
  const counts = {
    total: count,
    active: Math.min(1, count),
    queued: 0,
    running: Math.min(1, count),
    waiting: 0,
    succeeded: Math.max(0, count - failed - attention - 1),
    failed,
    canceled: 0,
    needsAttention: attention,
    errorRate: count ? Math.round(((failed + attention) / count) * 1000) / 10 : 0,
    avgDurationMs: 2_900,
    p99DurationMs: 8_400,
    lastRunAt: runs[0]?.createdAt ?? null,
  };
  return {
    frame: { ...frame, route: { kind: "workflows", activeKey: "workflow:W1" } },
    revision: FIXTURE_REVISION,
    baseId: "Bas001",
    tables: frame.catalog.tables,
    activeWorkflow: workflow,
    workflowHref: "/app/grids/Bas001/workflows/W1",
    selectedRunId: selectedRun?.id ?? null,
    initialSelectedRun: selectedRun
      ? {
          run: selectedRun,
          inputLabels: {},
          provenance: { workflowName: workflow.name, actorLabel: "Mira Solberg", serviceAccountLabel: null, launcherName: null },
          steps: [],
          stepsTruncated: false,
          documents: { items: [], total: 0, hasMore: false, nextOffset: null },
        }
      : null,
    workflows: [workflow],
    workflowLevels: { W1: "admin" },
    canRunActiveWorkflow: true,
    canManageActiveWorkflow: true,
    editMode: false,
    initialOverview: {
      filters,
      stats: {
        window: filters.window,
        ...counts,
        failedLast24h: failed,
        byWorkflow: [{ workflowId: "W1", latestStatus: runs[0]?.status ?? null, ...counts }],
      },
      runs: { items: runs, nextCursor: null },
      launchers: [],
      triggerState: {
        schedule: null,
        recordEvents: [{ tableId: frame.catalog.tables[0]!.id, event: "updated", state: "active", hasFilter: true }],
      },
    },
    liveCursor: null,
  };
};
