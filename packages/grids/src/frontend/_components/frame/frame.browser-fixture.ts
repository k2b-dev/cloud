/**
 * Invented data for the v2 frame's browser tests: Grids before its first base, and a base home with its switcher in
 * three states. `plain` is a small team's Grids, `worst` the break-ui catalogue (long and unbreakable names, one
 * letter, non-Latin, emoji, huge counts), `huge` a Grids with 1,000 bases and a base with 1,000 tables.
 */
import type { PublicBase, PublicTable } from "../../../api/public-dto";
import type { BaseTemplate } from "../overview/CreateBaseDialog";
import type { GridsStartProps } from "../overview/GridsStart";
import type { PublicOkWorkspaceState } from "../workspace/workspace-public-state-model";
import type { HomeActivity } from "./base-activity-model";
import type { GridsBases } from "./GridsFrame";

export type FixtureVariant = "plain" | "worst" | "huge";

export const FIXTURE_REVISION = { revision: "r1", resources: { "base:Bas001": "b1" } };
export const FIXTURE_NOW = "2026-11-25T09:00:00.000Z";
const minutesAgo = (minutes: number) => new Date(Date.parse(FIXTURE_NOW) - minutes * 60_000).toISOString();

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

const WORST_BASES = [
  base("Bas101", "Ersatzteilverwaltung-und-Reparaturdokumentation-der-Werkstatt-Nordhausen-Ost-2026", null),
  base("Bas102", "X", "Y"),
  base("Bas103", "物流センター東京 – 在庫と出荷", "倉庫ごとの在庫数、入荷、出荷予定を一つの表で管理します。"),
  base("Bas104", "🚚 Fuhrpark 🔧", "Fahrzeuge, TÜV-Termine, Schäden 💥 und Tankkarten"),
  base("Bas105", "Kunden", null),
  base("Bas106", "Sozialversicherungsfachangestelltenausbildungsunterlagen", null),
];

/** The four templates as the server lists them (their real names, signs and main tables). */
const TEMPLATES: BaseTemplate[] = [
  {
    id: "bookshop",
    name: "Buchhandlung",
    description: "Bücher, Kunden, Bestellungen und Versand",
    icon: "ti ti-books",
    highlights: ["Katalog mit Autoren und Genres", "Bestellungen mit Positionen", "App für den Laden"],
  },
  {
    id: "finance",
    name: "Private Finanzen",
    description: "Konten, Ausgaben, Budgets und Belege",
    icon: "ti ti-wallet",
    highlights: ["Transaktionen mit Kategorien", "Budgets je Monat", "Formular für Belege"],
  },
  {
    id: "inventory",
    name: "Inventar",
    description: "Gegenstände, Lagerorte, Ausleihen und Reparaturen",
    icon: "ti ti-packages",
    highlights: ["Gegenstände mit Lagerort", "Ausleihen mit Positionen", "App für die Ausgabe"],
  },
  {
    id: "billing",
    name: "Rechnungswesen",
    description: "Rechnungen, Korrekturen und Gutschriften",
    icon: "ti ti-receipt",
    highlights: ["Rechnungen mit Positionen", "Geschäftspartner", "Zahlungen"],
  },
];

/** Grids before the first base: blank and the three templates the page offers, with their real main tables. */
export const startFixture = (params: URLSearchParams): GridsStartProps => ({
  ways: [
    { id: "blank", name: "Leere Base", icon: "plus", preview: null },
    {
      id: "finance",
      name: "Private Finanzen",
      icon: "wallet",
      preview: {
        tables: 5,
        columns: [{ name: "Datum" }, { name: "Betrag", align: "end" }, { name: "Kategorie" }],
        rows: [
          ["01.04.", "3.200,00", "Gehalt"],
          ["02.04.", "980,00", "Miete"],
          ["18.04.", "28,90", "Bücher"],
        ],
      },
    },
    {
      id: "inventory",
      name: "Inventar",
      icon: "packages",
      preview: {
        tables: 6,
        columns: [{ name: "Name" }, { name: "Lagerort" }, { name: "Status" }],
        rows: [
          ["Kamera", "Regal 2", "Verfügbar"],
          ["Stativ", "Regal 1", "Reserviert"],
          ["Mikrofon", "Kiste 4", "Verfügbar"],
        ],
      },
    },
    {
      id: "billing",
      name: "Rechnungswesen",
      icon: "receipt",
      preview: {
        tables: 3,
        columns: [{ name: "Nr." }, { name: "Betrag", align: "end" }, { name: "Kunde" }],
        rows: [
          ["RE-0001", "1.190,00", "Nordlicht"],
          ["RE-0002", "476,00", "Weber"],
          ["RE-0003", "89,25", "Atelier K"],
        ],
      },
    },
  ],
  templates: TEMPLATES,
  create: params.get("new"),
});

/** The switcher's bases for a variant: the five opened last (the open one first), then the others by name. */
export const basesFixture = (variant: FixtureVariant, params: URLSearchParams): GridsBases => {
  const open = base("Bas001", variant === "worst" ? "Ersatzteilverwaltung-und-Reparaturdokumentation-Nordhausen" : "Werkstatt", null);
  const others =
    variant === "huge"
      ? Array.from({ length: 999 }, (_, index) => base(`H${String(index + 1).padStart(5, "0")}`, `Base ${index + 1}`, null))
      : variant === "worst"
        ? WORST_BASES
        : PLAIN_BASES.slice(1);
  const choice = (each: PublicBase) => ({ id: each.id, name: each.name });
  return {
    recent: [open, ...others.slice(0, 4)].map(choice),
    others: others
      .slice(4)
      .map(choice)
      .sort((a, b) => a.name.localeCompare(b.name, "de")),
    templates: TEMPLATES,
    create: params.get("new"),
    canCreate: true,
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
