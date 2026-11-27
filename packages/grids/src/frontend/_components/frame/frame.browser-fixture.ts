/**
 * Invented data for the v2 frame's browser tests: the bases overview and a base home in three states. `plain` is a
 * small team's Grids, `worst` the break-ui catalogue (long and unbreakable names, one letter, non-Latin, emoji,
 * missing descriptions, huge counts), `huge` a Grids with 1,000 bases and a base with 1,000 tables.
 */
import type { PublicBase, PublicTable } from "../../../api/public-dto";
import type { BasesOverviewProps } from "../overview/BasesOverview";
import type { PublicOkWorkspaceState } from "../workspace/workspace-public-state-model";
import type { HomeActivity } from "./base-activity-model";

export type FixtureVariant = "plain" | "worst" | "huge";

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

/** A small company's Grids: as many bases as a team keeps, most described, one not. */
const PLAIN_BASES = [
  base("Bas001", "Werkstatt", "Aufträge, Ersatzteile und Termine"),
  base("Bas002", "Lager Nord", "Bestand und Einlieferungen"),
  base("Bas003", "Kunden", null),
  base("Bas004", "Personal", "Urlaub, Schichten und Schulungen"),
  base("Bas005", "Fuhrpark", "Fahrzeuge, TÜV-Termine und Tankkarten"),
  base("Bas006", "Einkauf", "Lieferanten, Bestellungen und Preise"),
  base("Bas007", "Geräteverleih", "Geräte, Ausleihen und Rückgaben"),
  base("Bas008", "Projekte 2026", "Baustellen, Abnahmen und Mängel"),
  base("Bas009", "Buchhaltung", "Rechnungen, Zahlungen und Mahnungen"),
];

/** What tables of a small company are called, for the recently changed ones. */
const TABLE_NAMES = ["Aufträge", "Bestand", "Kontakte", "Urlaub", "Fahrzeuge", "Bestellungen", "Ausleihen", "Mängel", "Rechnungen"];

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
  const bases = search ? all.filter((each) => `${each.name} ${each.description ?? ""}`.toLowerCase().includes(search)) : all;
  const apps =
    variant === "plain"
      ? [
          { id: "App0", name: "Annahme-Terminal", icon: "scan", baseName: "Werkstatt" },
          { id: "App1", name: "Geräteausgabe", icon: "package", baseName: "Geräteverleih" },
          { id: "App2", name: "Schichtplan", icon: "calendar", baseName: "Personal" },
        ]
      : Array.from({ length: 8 }, (_, index) => ({
          id: `App${index}`,
          name: variant === "worst" && index === 0 ? "Ausgabe-und-Rücknahme-Terminal-für-Leihgeräte-im-Erdgeschoss" : `App ${index + 1}`,
          icon: index % 2 ? "scan" : null,
          baseName: variant === "worst" && index === 1 ? "物流センター東京" : "Lager Nord",
        }));
  return {
    page,
    bases,
    total: search ? bases.length : variant === "huge" ? 1000 : all.length,
    templates: TEMPLATES,
    baseStats: stats(bases, variant === "worst"),
    recentTables: bases.slice(0, 12).map((each, index) => ({
      id: `Tab${index}`,
      baseId: each.id,
      baseName: each.name,
      name:
        variant === "worst" && index === 0
          ? "Wartungsprotokolle-der-Hebebühnen-und-Druckluftanlagen"
          : variant === "huge"
            ? `Tabelle ${index + 1}`
            : (TABLE_NAMES[index % TABLE_NAMES.length] ?? "Aufträge"),
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
    table("T4", "Kunden", "ti ti-users"),
    table("T5", "Lieferanten", "ti ti-truck"),
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
                ...(tables[3] ? [{ type: "table", id: tables[3].id }] : []),
              ],
            },
            {
              id: "G3",
              name: "Lager",
              entries: [tables[1], tables[4]].flatMap((each) => (each ? [{ type: "table", id: each.id }] : [])),
            },
            {
              id: "G2",
              name: variant === "worst" ? "Auswertungen-und-Berichte-für-die-Geschäftsführung-2026" : "Auswertung",
              entries: [
                { type: "view", id: "V1" },
                { type: "view", id: "V2" },
                { type: "documentTemplate", id: "D1" },
                { type: "workflow", id: "W1" },
              ],
            },
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

/** Fourteen days of new records with a working week's rhythm: quiet weekends, a busier Monday. */
const fortnight = (scale: number, offset = 0) =>
  Array.from({ length: 14 }, (_, day) => {
    const weekday = (day + offset) % 7;
    return weekday >= 5 ? Math.round(scale * 0.15) : Math.round(scale * (0.6 + ((day * 37 + offset * 11) % 9) / 10));
  });

/**
 * What happens in the base for its home: new records with their days, the exceptions and who changed what last,
 * shaped like the server's HomeActivity (public table ids).
 */
export const homeActivityFixture = (variant: FixtureVariant): HomeActivity => {
  const tables = tablesOf(variant);
  if (variant === "huge")
    return {
      total: 48_210,
      points: fortnight(180),
      tables: Object.fromEntries(
        tables.map((table, index) => [
          table.id,
          { total: (index * 37) % 400, points: index < 200 ? fortnight((index % 9) + 1, index) : null },
        ]),
      ),
      pendingFinalizations: 0,
      failedRuns24h: 0,
      recent: [],
    };
  const orders = fortnight(variant === "worst" ? 3_400 : 9);
  const parts = fortnight(variant === "worst" ? 40 : 3, 2);
  const people = ["Mira Solberg", "Jonas Kern", "Felix Thal", "Sami Yilmaz"];
  const perTable: HomeActivity["tables"] = {
    [tables[0]!.id]: { total: variant === "worst" ? 128_340_118 : 1_284, points: orders },
    [tables[1]!.id]: { total: variant === "worst" ? 5_092 : 312, points: parts },
    ...(tables[2] ? { [tables[2].id]: { total: 58, points: Array.from({ length: 14 }, () => 0) } } : {}),
    ...(tables[3] ? { [tables[3].id]: { total: variant === "worst" ? 1 : 214, points: fortnight(variant === "worst" ? 0 : 1, 4) } } : {}),
    ...(tables[4] ? { [tables[4].id]: { total: 46, points: fortnight(0.4, 1) } } : {}),
  };
  const series = Object.values(perTable);
  return {
    // the base's figures are the sum of its tables, as the server counts them
    total: series.reduce((sum, each) => sum + each.total, 0),
    points: Array.from({ length: 14 }, (_, day) => series.reduce((sum, each) => sum + (each.points?.[day] ?? 0), 0)),
    tables: perTable,
    pendingFinalizations: variant === "worst" ? 1_204 : 3,
    failedRuns24h: variant === "worst" ? 87 : 2,
    recent: [
      ["Küchenfront Eiche", 0, 4],
      ["Hebebühne Wartung", 1, 18],
      [
        variant === "worst" ? "Wartungsprotokoll-der-Hebebühnen-und-Druckluftanlagen-im-Werk-Süd-2026-final" : "Druckluftanlage Halle 3",
        0,
        42,
      ],
      [null, 1, 75],
      ["Empfangstresen", 0, 130],
      ["Regal Archiv", 0, 260],
    ].map(([title, table, minutes], index) => ({
      tableId: tables[Number(table)]?.id ?? tables[0]!.id,
      recordShortId: `REC${String(index + 1).padStart(3, "0")}`,
      title: title as string | null,
      updatedAt: minutesAgo(Number(minutes)),
      // a change by an import or a workflow has no person
      person: variant === "worst" && index === 3 ? null : { name: people[index % people.length]! },
    })),
  };
};
