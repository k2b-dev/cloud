import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import AdminNotebooksScreen, { type AdminNotebookDetail, type AdminNotebookPrincipal, type AdminNotebookRow } from "./AdminNotebooksScreen";

/** The moment the invented activity was read; every relative time counts from it. */
const now = "2026-11-26T10:00:00.000Z";
const hoursAgo = (hours: number) => new Date(Date.parse(now) - hours * 3_600_000).toISOString();

/**
 * A notebook's changes on each of the last 30 days, invented but steady: a weekly rhythm at its own `level`, quiet at
 * the weekends, and nothing before the day it last went quiet (`quietFor` days ago).
 */
const changes = (index: number, level: number, quietFor = 0) =>
  Array.from({ length: 30 }, (_, day) => {
    const ago = 29 - day;
    if (ago < quietFor || level === 0) return 0;
    const weekend = (day + index) % 7 >= 5;
    return weekend ? ((day + index) % 3 === 0 ? 1 : 0) : Math.max(0, Math.round(level * (0.6 + ((day * 7 + index * 13) % 10) / 10)));
  });

/** Invented people and groups of an installation; a notebook's access takes them in turn. */
const principals: AdminNotebookPrincipal[] = [
  ...["Ada Renz", "Jana Berger", "Tom Ochs", "Lena Hartwig", "Mira Sander", "Sami Yilmaz", "Felix Thal", "Jonas Kern"].map(
    (name, index): AdminNotebookPrincipal => ({
      kind: "user",
      id: `00000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
      name,
      avatarHash: null,
    }),
  ),
  { kind: "group", id: "00000000-0000-4000-b000-000000000001", name: "Lager", avatarHash: null },
  { kind: "group", id: "00000000-0000-4000-b000-000000000002", name: "Buchhaltung", avatarHash: null },
];
/** The first who have access, people first, as the server sends them. */
const accessOf = (index: number, count: number) =>
  Array.from({ length: Math.min(3, count) }, (_, place) => principals[(index * 3 + place) % principals.length]!).sort(
    (a, b) => Number(a.kind !== "user") - Number(b.kind !== "user"),
  );

type Fixture = AdminNotebookRow & { changesPerDay: number[]; description: string | null };
type Tuple = readonly [string, string | null, number, number, number, number, number | null];
const fixtures = (tuples: readonly Tuple[], prefix: string): Fixture[] =>
  tuples.map(([name, icon, permissionCount, noteCount, level, quietFor, lastHours], index) => ({
    id: `00000000-0000-4000-${prefix}-${String(index).padStart(12, "0")}`,
    shortId: `${prefix === "8000" ? "nb" : "wc"}${String(index).padStart(4, "0")}`,
    name,
    icon,
    permissionCount,
    noteCount,
    lastActivityAt: lastHours === null ? null : hoursAgo(lastHours),
    access: accessOf(index, permissionCount),
    // "Ein Eintrag": exactly one change, today
    changesPerDay: name === "Ein Eintrag" ? [...Array(29).fill(0), 1] : changes(index, level, quietFor),
    description: index % 3 === 0 ? "Abläufe, Stationen und Schichten, gepflegt vom Team." : null,
  }));

/** Invented notebooks: enough to fill a page, with one that nobody can reach and some gone quiet. */
const rows = fixtures(
  [
    ["Handbuch Lager", "ti ti-forklift", 6, 148, 9, 0, 2],
    ["Projekt Hallenumbau", "ti ti-building", 4, 63, 6, 0, 5],
    ["Einkauf 2027", "ti ti-shopping-cart", 3, 41, 3, 0, 26],
    ["Onboarding", "ti ti-school", 12, 27, 2, 0, 50],
    ["Altes Wiki", "ti ti-archive", 0, 312, 0, 0, 24 * 212],
    ["Qualitätssicherung", "ti ti-checklist", 5, 86, 4, 0, 4],
    ["Fuhrpark", "ti ti-truck", 2, 19, 1, 3, 24 * 3 + 2],
    ["Team Vertrieb", "ti ti-users", 7, 104, 7, 0, 1],
    ["Buchhaltung", "ti ti-calculator", 4, 58, 3, 0, 20],
    ["Personal", "ti ti-id-badge", 3, 35, 1, 6, 24 * 6 + 4],
    ["IT-Betrieb", "ti ti-server", 6, 77, 5, 0, 3],
    ["Marketing", "ti ti-speakerphone", 5, 44, 2, 0, 28],
    ["Kundendienst", "ti ti-headset", 9, 129, 8, 0, 1],
    ["Arbeitssicherheit", "ti ti-shield-check", 8, 22, 1, 12, 24 * 12],
    ["Lieferantenbewertung", "ti ti-star", 2, 12, 0, 0, 24 * 48],
    ["Messe 2027", "ti ti-presentation", 4, 31, 3, 0, 7],
    ["Produktion Linie 2", "ti ti-settings-automation", 6, 93, 6, 0, 2],
    ["Reisekosten", "ti ti-plane", 3, 9, 0, 0, 24 * 95],
    ["Betriebsrat", "ti ti-gavel", 2, 26, 1, 9, 24 * 9 + 6],
    ["Nachhaltigkeit", "ti ti-leaf", 3, 15, 0, 0, 24 * 61],
    ["Ideen", "ti ti-bulb", 11, 54, 2, 0, 30],
    ["Recht", "ti ti-scale", 2, 18, 0, 0, null],
    ["Standort Nord", "ti ti-map-pin", 4, 23, 1, 2, 24 * 2 + 3],
    ["Archiv 2025", "ti ti-box", 1, 402, 0, 0, 24 * 330],
  ],
  "8000",
);

/**
 * `?data=worst`: the worst an installation realistically holds, spread over the first rows: a name at the API's limit
 * of 120 signs, an address as a name, one letter, emoji, Japanese and Arabic, five-digit access counts and notes, a
 * notebook whose activity reaches back to no event and has no icon, and figures in the ten thousands.
 */
const worstRows = fixtures(
  [
    [
      "Qualitätsmanagementhandbuch für die Zertifizierung nach DIN EN ISO 9001:2015 – Standort Nord, Werk II, Halle 3 (Entw.)",
      "ti ti-checklist",
      14,
      1048,
      40,
      0,
      1,
    ],
    ["https://wiki.northwind-industries-holdings.example.com/spaces/QM/pages/migration", "ti ti-world", 3, 77, 6, 0, 3],
    ["Q", "ti ti-letter-q", 1, 1, 1, 0, 26],
    ["🚀🎉 Launch Q1 🎯", "ti ti-rocket", 6, 18, 9, 0, 2],
    ["製品開発ロードマップ 2027 – 第三四半期の計画と課題", "ti ti-map", 4, 230, 3, 0, 50],
    ["دليل الموظفين الجدد", "ti ti-book", 0, 0, 0, 0, 24 * 400],
    ["Alle Mitarbeitenden", "ti ti-users", 12480, 48213, 18000, 0, 0],
    ["Ein Eintrag", null, 1, 1, 0, 0, 3],
  ],
  "9000",
);

/** The figures as the server counts them over the given notebooks. */
const summaryOf = (of: Fixture[]) => {
  const active = of.filter((row) => row.changesPerDay.some((value) => value > 0));
  const quiet = of.filter((row) => !active.includes(row)).sort((a, b) => a.name.localeCompare(b.name, "de"));
  const orphaned = of.filter((row) => row.permissionCount === 0);
  return {
    orphaned: orphaned.length,
    active: active.length,
    activePerDay: Array.from({ length: 30 }, (_, day) => of.filter((row) => (row.changesPerDay[day] ?? 0) > 0).length),
    orphanedNames: orphaned.slice(0, 2).map((row) => row.name),
    quietNames: quiet.slice(0, 2).map((row) => row.name),
  };
};
/** The worst case's installation: tens of thousands of notebooks, the exceptions named by their longest names. */
const worstSummary = {
  orphaned: 1204,
  active: 9302,
  activePerDay: Array.from({ length: 30 }, (_, day) => 3800 + ((day * 37) % 11) * 40),
  orphanedNames: [worstRows[0]!.name, worstRows[1]!.name],
  quietNames: [worstRows[5]!.name, worstRows[0]!.name],
};

/** What the server sends for the open notebook (`?open=`): its access, who writes in it and its history. */
const detailOf = (row: Fixture | undefined): AdminNotebookDetail | undefined => {
  if (!row) return undefined;
  const index = Number(row.shortId.slice(2));
  const people = principals.filter((principal) => principal.kind === "user");
  const access = Array.from({ length: Math.min(row.permissionCount, 6) }, (_, place) => ({
    principal: principals[(index * 3 + place) % principals.length]!,
    permission: place === 0 ? "admin" : place % 2 ? "write" : "read",
  }));
  // a busy notebook has its regular writers; one with a single change (or none known) has one writer or none
  const total = row.changesPerDay.reduce((sum, value) => sum + value, 0);
  const writers =
    total > 10
      ? people
          .slice(0, 4)
          .map((person, place) => ({ ...person, changes: [42, 17, 6, 1][place]!, lastAt: hoursAgo([2, 5, 30, 200][place]!) }))
      : total > 0
        ? [{ ...people[1]!, changes: total, lastAt: row.lastActivityAt ?? hoursAgo(1) }]
        : [];
  const notes = ["Wareneingang", "Schichtplan Dezember", "Inventur 2026", "Stapler-Einweisung"];
  return {
    shortId: row.shortId,
    name: row.name,
    icon: row.icon,
    description: row.description ?? (row.permissionCount === 0 ? "Abgelöst durch das neue Handbuch, seit April unverändert." : null),
    createdAt: "2025-10-02T08:00:00.000Z",
    noteCount: row.noteCount,
    lastActivityAt: row.lastActivityAt,
    changesPerDay: row.changesPerDay,
    access,
    accessTotal: row.permissionCount,
    writers,
    history:
      writers.length > 1
        ? [
            ["note.edited", 0, 2],
            ["comment.created", 1, 5],
            ["note.created", 0, 26],
            ["note.edited", 2, 30],
            ["note.restored", 3, 200],
          ].map(([action, who, hours], place) => ({
            id: String(place),
            actor: people[who as number]!,
            action: action as string,
            noteTitle: notes[place % notes.length]!,
            at: hoursAgo(hours as number),
          }))
        : row.lastActivityAt === null
          ? []
          : [{ id: "0", actor: writers[0] ?? people[4]!, action: "note.edited", noteTitle: notes[0]!, at: row.lastActivityAt }],
  };
};

const root = document.getElementById("root");
if (root) {
  const params = new URLSearchParams(location.search);
  const locale = params.get("lang") === "en" ? "en" : "de";
  const empty = params.get("empty") === "1";
  const data = params.get("data");
  document.documentElement.lang = locale;
  // `?data=one`: an installation with one notebook, every count at 1
  const shown = empty ? [] : data === "worst" ? worstRows : data === "one" ? worstRows.slice(-1) : rows;
  render(
    () => (
      <LocaleProvider locale={locale}>
        <AdminNotebooksScreen
          nav={{
            title: "Administration",
            icon: "settings",
            groups: [
              {
                label: "Apps",
                items: [
                  { label: "Mail", icon: "mail", href: "/admin/mail" },
                  { label: "Notizbücher", icon: "note", href: "/admin/notebooks", current: true },
                  { label: "Dateien", icon: "folder", href: "/admin/files" },
                ],
              },
            ],
          }}
          color="#eab308"
          rows={shown}
          // `?pages=2`: more notebooks than one page holds
          total={data === "worst" ? 12847 : params.get("pages") === "2" ? 124 : shown.length}
          page={1}
          pages={data === "worst" ? 129 : params.get("pages") === "2" ? 2 : 1}
          search={params.get("search") ?? ""}
          summary={data === "worst" ? worstSummary : summaryOf(shown)}
          detail={detailOf(shown.find((row) => row.shortId === params.get("open")))}
          dateConfig={{ timeZone: "Europe/Berlin", locale, firstDayOfWeek: 1 }}
          now={now}
        />
      </LocaleProvider>
    ),
    root,
  );
}
