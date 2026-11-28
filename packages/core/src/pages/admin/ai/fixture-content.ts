/** Invented skills and projects for the AI area's browser fixture (Skills, Projects). Neutral names, example.org. */
import type { AiAppSkillIssue, AiProjectAdminListItem, AiSkillAdminListItem } from "@k2b/cloud/ai";
import type { AiProjectsData, AiSkillsData } from "./content-data";
import type { AiFixtureApi, AiFixtureInput } from "./fixture-types";

const PER_PAGE = 100;
const APPS = { grids: "Grids", mail: "Mail", contacts: "Kontakte", spaces: "Spaces", weather: "Wetter" };
const day = (offset: number) => new Date(Date.UTC(2026, 10, 26 - offset, 9 + (offset % 8), (offset * 7) % 60)).toISOString();
/** The server words times in the viewer's zone; the fixture words them the same way, Berlin in November. */
const word = (iso: string) => {
  const date = new Date(Date.parse(iso) + 3_600_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
};

const skill = (index: number, extra: Partial<AiSkillAdminListItem> & Pick<AiSkillAdminListItem, "name">): AiSkillAdminListItem => ({
  id: `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, "0")}`,
  shortId: `sk${String(index).padStart(4, "0")}`,
  description: "",
  revision: 2,
  source: null,
  referenceCount: 1,
  accessCount: 4,
  adminCount: 1,
  createdAt: day(index + 30),
  updatedAt: day(index),
  ...extra,
});
const fromApp = (appId: keyof typeof APPS, status: "current" | "modified" | "update_available", available = true) => ({
  appId,
  appName: APPS[appId],
  status,
  available,
  appVersion: status === "update_available" ? "d".repeat(64) : null,
});

const normalSkills = (): AiSkillAdminListItem[] => [
  skill(1, {
    name: "Rechnungen prüfen",
    description: "Prüft eingehende Rechnungen auf Betrag, Fälligkeit und Kostenstelle.",
    accessCount: 38,
    adminCount: 2,
    referenceCount: 4,
  }),
  skill(2, { name: "cloud-grids", source: fromApp("grids", "current"), adminCount: 0, accessCount: 0, referenceCount: 6 }),
  skill(3, { name: "cloud-mail", source: fromApp("mail", "modified"), adminCount: 1, accessCount: 12, referenceCount: 3 }),
  skill(4, { name: "cloud-contacts", source: fromApp("contacts", "update_available"), adminCount: 0, accessCount: 0, referenceCount: 2 }),
  skill(5, {
    name: "Protokoll schreiben",
    description: "Fasst Besprechungen als Protokoll mit Aufgaben zusammen.",
    accessCount: 64,
    adminCount: 3,
  }),
  skill(6, { name: "Angebot entwerfen", accessCount: 9, adminCount: 0 }),
  skill(7, { name: "cloud-weather", source: fromApp("weather", "current", false), adminCount: 0, accessCount: 0 }),
  skill(8, { name: "Bewerbungen sichten", accessCount: 5, adminCount: 1, referenceCount: 0 }),
  skill(9, { name: "Pressemitteilung", accessCount: 17, adminCount: 2 }),
  skill(10, { name: "Vertragsklauseln vergleichen", accessCount: 21, adminCount: 1, referenceCount: 8 }),
  skill(11, { name: "Übersetzung Englisch", accessCount: 112, adminCount: 2 }),
  skill(12, { name: "Code-Review", accessCount: 7, adminCount: 0, referenceCount: 2 }),
  skill(13, { name: "Social-Media-Beitrag", accessCount: 3, adminCount: 1 }),
  skill(14, { name: "Reisekosten abrechnen", accessCount: 46, adminCount: 1, referenceCount: 1 }),
];

/** Break-ui: long and unbreakable names, one letter, non-Latin text, emoji, extreme counts, a full page of 100. */
const worstSkills = (): AiSkillAdminListItem[] =>
  Array.from({ length: PER_PAGE }, (_, index) => {
    const names = [
      "Sehr ausführliche Prüfung eingehender Rechnungen samt Kostenstellenzuordnung und Freigabeweg für die Buchhaltung",
      "skill-ohne-leerzeichen-mit-einem-sehr-langen-namen-der-nirgends-umbrechen-kann-0123456789abcdef",
      "Q",
      "契約書の比較とリスク評価",
      "🚀 Launch-Checkliste ✅",
    ];
    return skill(index + 1, {
      name: names[index % names.length]!,
      description:
        index % 5 === 0
          ? "Eine Beschreibung, die sehr lang ist und über viele Zeilen läuft, damit die Ansicht zeigt, wie sie umbricht. ".repeat(4)
          : "",
      source: index % 7 === 1 ? fromApp("spaces", index % 2 ? "update_available" : "modified", index % 3 !== 0) : null,
      accessCount: index % 4 === 0 ? 987_654 : index,
      adminCount: index % 3 === 0 ? 0 : 12_345,
      referenceCount: index % 6 === 0 ? 99_999 : 0,
    });
  });

const issues = (): AiAppSkillIssue[] => [
  { appId: "spaces", appName: "Spaces", name: "cloud-spaces", state: "deleted", available: true },
  { appId: "contacts", appName: "Kontakte", name: "cloud-contacts-import", state: "name_taken", available: true },
  { appId: "mail", appName: "Mail", name: "mail-signature", state: "invalid", available: false },
];

export const skillsFixture = (input: AiFixtureInput): AiSkillsData => {
  const skills = input.state === "empty" ? [] : input.state === "worst" ? worstSkills() : normalSkills();
  const search = (input.params.get("search") ?? "").trim();
  const shown = search ? skills.filter((entry) => entry.name.toLowerCase().includes(search.toLowerCase())) : skills;
  const total = input.state === "worst" ? 12_345 : shown.length;
  const requested = Number.parseInt(input.params.get("page") ?? "1", 10);
  const open = input.params.get("skill");
  const rows = shown.map((entry) => ({ ...entry, updated: word(entry.updatedAt), created: word(entry.createdAt) }));
  return {
    skills: rows,
    summary: {
      total,
      unmanaged: input.state === "worst" ? 4_115 : shown.filter((entry) => entry.adminCount === 0 && !entry.source).length,
      totalAccess: input.state === "worst" ? 98_765_432 : shown.reduce((sum, entry) => sum + entry.accessCount, 0),
    },
    appSkillIssues: input.state === "empty" ? [] : issues(),
    appNames: APPS,
    total,
    page: Number.isFinite(requested) && requested > 0 ? requested : 1,
    perPage: PER_PAGE,
    search,
    open: rows.some((entry) => entry.shortId === open) ? open : null,
  };
};

const project = (index: number, extra: Partial<AiProjectAdminListItem> & Pick<AiProjectAdminListItem, "name">): AiProjectAdminListItem => ({
  id: `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, "0")}`,
  shortId: `pj${String(index).padStart(4, "0")}`,
  description: "",
  icon: "ti ti-folders",
  accessCount: 6,
  adminCount: 1,
  createdAt: day(index + 40),
  updatedAt: day(index),
  ...extra,
});

const normalProjects = (): AiProjectAdminListItem[] => [
  project(1, {
    name: "Website-Relaunch",
    icon: "ti ti-world",
    description: "Texte, Struktur und Bildsprache der neuen Website.",
    accessCount: 14,
    adminCount: 2,
  }),
  project(2, { name: "Jahresabschluss 2026", icon: "ti ti-calculator", accessCount: 5, adminCount: 1 }),
  project(3, { name: "Kundenservice", icon: "ti ti-headset", accessCount: 31, adminCount: 3 }),
  project(4, { name: "Altes Intranet", icon: "ti ti-archive", accessCount: 2, adminCount: 0 }),
  project(5, { name: "Messe Frühjahr", icon: "ti ti-presentation", accessCount: 9, adminCount: 1 }),
  project(6, { name: "Forschungsantrag", icon: "ti ti-flask", accessCount: 4, adminCount: 2 }),
  project(7, { name: "Onboarding", icon: "ti ti-user-plus", accessCount: 58, adminCount: 1 }),
  project(8, { name: "Ausschreibung Fuhrpark", icon: "", accessCount: 3, adminCount: 0 }),
  project(9, { name: "Vertrieb Süd", icon: "ti ti-chart-line", accessCount: 12, adminCount: 1 }),
  project(10, { name: "Datenschutz", icon: "ti ti-shield-lock", accessCount: 7, adminCount: 2 }),
];

const worstProjects = (): AiProjectAdminListItem[] =>
  Array.from({ length: PER_PAGE }, (_, index) =>
    project(index + 1, {
      name: [
        "Gemeinsames Projekt der Arbeitsgruppen für Forschung, Lehre und Verwaltung mit einem sehr langen Namen",
        "projekt-ohne-leerzeichen-mit-einem-sehr-langen-namen-der-nirgends-umbrechen-kann-0123456789",
        "Z",
        "研究プロジェクト東京",
        "🎉 Sommerfest",
      ][index % 5]!,
      icon: index % 2 ? "ti ti-folders" : "",
      accessCount: index % 4 === 0 ? 987_654 : index,
      adminCount: index % 3 === 0 ? 0 : 12_345,
    }),
  );

export const projectsFixture = (input: AiFixtureInput): AiProjectsData => {
  const projects = input.state === "empty" ? [] : input.state === "worst" ? worstProjects() : normalProjects();
  const search = (input.params.get("search") ?? "").trim();
  const shown = search ? projects.filter((entry) => entry.name.toLowerCase().includes(search.toLowerCase())) : projects;
  const total = input.state === "worst" ? 12_345 : shown.length;
  const requested = Number.parseInt(input.params.get("page") ?? "1", 10);
  const open = input.params.get("project");
  const rows = shown.map((entry) => ({ ...entry, updated: word(entry.updatedAt), created: word(entry.createdAt) }));
  return {
    projects: rows,
    summary: {
      total,
      unmanaged: input.state === "worst" ? 4_115 : shown.filter((entry) => entry.adminCount === 0).length,
      totalAccess: input.state === "worst" ? 98_765_432 : shown.reduce((sum, entry) => sum + entry.accessCount, 0),
    },
    total,
    page: Number.isFinite(requested) && requested > 0 ? requested : 1,
    perPage: PER_PAGE,
    search,
    open: rows.some((entry) => entry.shortId === open) ? open : null,
  };
};

const access = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    principal: { type: "user", userId: "10000000-0000-4000-8000-000000000001" },
    permission: "admin",
    createdAt: "2026-11-04T00:00:00.000Z",
    displayName: "Mia Muster",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    principal: { type: "group", groupId: "10000000-0000-4000-8000-000000000002" },
    permission: "read",
    createdAt: "2026-11-04T00:00:00.000Z",
    displayName: "Gruppe Vertrieb",
  },
];

/** Skills and Projects API: deletes, app Skill deeds and the app version answer; `state=failwrite` refuses writes. */
export const contentApi: AiFixtureApi = (request, url, state) => {
  const path = url.pathname;
  if (!path.startsWith("/api/admin/core/ai-skills") && !path.startsWith("/api/admin/core/ai-projects")) return undefined;
  if (state === "failwrite" && request.method !== "GET")
    return Response.json({ message: "Synthetic fixture: the change was refused." }, { status: 409 });
  if (request.method === "GET" && /\/access$/.test(path)) return Response.json({ access });
  if (request.method === "GET" && /\/projects$/.test(path)) return Response.json({ projects: [{ id: "p1", name: "Website-Relaunch" }] });
  if (request.method === "GET" && /\/app-version$/.test(path))
    return Response.json({
      appVersion: "d".repeat(64),
      current: { markdown: "---\nname: cloud-contacts\n---\n\nFinde Kontakte.\nAntworte kurz.\n", references: [] },
      app: {
        markdown: "---\nname: cloud-contacts\n---\n\nFinde Kontakte.\nAntworte mit Telefon und Mail.\n",
        references: [{ path: "references/felder.md", content: "Name\nTelefon\nMail\n" }],
      },
    });
  if (request.method === "DELETE" || request.method === "POST") return Response.json({ ok: true });
  return undefined;
};
