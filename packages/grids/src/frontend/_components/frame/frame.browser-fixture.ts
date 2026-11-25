/**
 * Invented data for the v2 frame's browser tests: the bases overview and a base home in three states. `plain` is a
 * small team's Grids, `worst` the break-ui catalogue (long and unbreakable names, one letter, non-Latin, emoji,
 * missing descriptions, huge counts), `huge` a Grids with 1,000 bases and a base with 1,000 tables.
 */
import type { PublicBase, PublicTable } from "../../../api/public-dto";
import type { BasesOverviewProps } from "../overview/BasesOverview";
import type { PublicOkWorkspaceState } from "../workspace/workspace-public-state-model";

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
  const bases = search ? all.filter((each) => `${each.name} ${each.description ?? ""}`.toLowerCase().includes(search)) : all;
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
    total: search ? bases.length : variant === "huge" ? 1000 : all.length,
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
