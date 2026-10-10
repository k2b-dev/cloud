import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiAppSkillIssue, AiSkillAdminListItem } from "@k2b/cloud/ai";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "core-ai-skills-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ LocaleProvider }, { default: AiSkillsAdminPanel }] = await Promise.all([import("@k2b/ui"), import("./AiSkillsAdminPanel.tsx")]);

const record = (overrides: Partial<AiSkillAdminListItem> & Pick<AiSkillAdminListItem, "shortId" | "name">): AiSkillAdminListItem => ({
  id: `id-${overrides.shortId}`,
  description: "A shared Skill.",
  revision: 1,
  source: null,
  referenceCount: 0,
  accessCount: 1,
  adminCount: 0,
  createdAt: "2026-08-21T10:00:00.000Z",
  updatedAt: "2026-08-21T10:00:00.000Z",
  ...overrides,
});

const panel = (skills: AiSkillAdminListItem[], appSkillIssues: AiAppSkillIssue[] = []) =>
  createComponent(AiSkillsAdminPanel, {
    skills,
    summary: { total: skills.length, unmanaged: 1, totalAccess: skills.length },
    total: skills.length,
    page: 1,
    perPage: 100,
    search: "",
    appSkillIssues,
    appNames: { contacts: "Kontakte" },
  });

const appSkills = [
  record({
    shortId: "cur234",
    name: "cloud-grids",
    source: { appId: "grids", appName: "Grids", status: "current", available: true, appVersion: null },
  }),
  record({
    shortId: "mod234",
    name: "cloud-mail",
    source: { appId: "mail", appName: "Mail", status: "modified", available: true, appVersion: null },
  }),
  record({
    shortId: "upd234",
    name: "cloud-contacts",
    source: { appId: "contacts", appName: "Contacts", status: "update_available", available: true, appVersion: "d".repeat(64) },
  }),
  record({
    shortId: "off234",
    name: "cloud-weather",
    source: { appId: "weather", appName: "Weather", status: "current", available: false, appVersion: null },
  }),
];
const issues: AiAppSkillIssue[] = [
  { appId: "spaces", appName: "Spaces", name: "cloud-spaces", state: "deleted", available: true },
  { appId: "notebooks", appName: "Notebooks", name: "cloud-notebooks", state: "name_taken", available: true },
  { appId: "inventory", appName: "Inventory", name: "inventory-counting", state: "invalid", available: true },
];

describe("AiSkillsAdminPanel", () => {
  test("keeps custom Skills as permission-owned recovery records", () => {
    const html = renderToString(() => panel([record({ shortId: "sKl234", name: "orphaned-skill", accessCount: 0 })]));
    expect(html).toContain("AI Skills");
    expect(html).toContain("Without admins");
    expect(html).toContain("recovery required");
    expect(html).toContain("No admins");
    expect(html).toContain("Custom");
    expect(html).toContain("Actions for orphaned-skill");
    expect(html).not.toContain("App Skills not installed");
  });

  test("shows the source app, its state, and app Skills that are not installed", () => {
    const html = renderToString(() => panel(appSkills, issues));
    for (const text of [
      "From app Grids",
      "From app Mail",
      "From app Kontakte",
      "Customized",
      "App update available",
      "App not available",
      "Managed by app",
      "App Skills not installed",
      "Deleted",
      "Name in use",
      "Invalid content",
      "Actions for app Skill cloud-spaces",
      "Actions for app Skill cloud-notebooks",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("No admins");
    expect(html).not.toContain("Actions for app Skill inventory-counting");
  });

  test("renders app records in the inherited German locale", () => {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de-CH",
        get children() {
          return panel(appSkills, issues);
        },
      }),
    );
    for (const text of [
      "KI-Skills",
      "Quelle",
      "Von App Grids",
      "Von App Kontakte",
      "Angepasst",
      "Update der App verfügbar",
      "App nicht verfügbar",
      "Von der App verwaltet",
      "Nicht installierte App-Skills",
      "Gelöscht",
      "Name vergeben",
      "Ungültiger Inhalt",
    ])
      expect(html).toContain(text);
  });
});
