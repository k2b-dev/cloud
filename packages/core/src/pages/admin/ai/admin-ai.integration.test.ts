import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@k2b/cloud";
import { aiProjects, aiSkills } from "@k2b/cloud/ai";
import { aiModelCatalog, aiQuotas, readAiAdminOverview } from "@k2b/cloud/ai/admin";
import type { User } from "@k2b/cloud/contracts";
import { registerSettings, toLegacySettingDefs } from "@k2b/cloud/services/settings/defaults";
import { meterSql } from "../../../../../../scripts/fixtures/sql-meter";
import { databaseSuite, useMigratedDatabase } from "../../../../../../scripts/fixtures/test-infra";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";
import { CORE_SETTINGS } from "../../../_settings";
import { parseAiAreaQuery } from "./area";
import type { AiPageInput } from "./page-input";
import type { AiCatalogIndex } from "./presentation";

// The settings loader words its recent changes with a Solid module; load the loaders through the SSR transform.
const root = mkdtempSync(join(tmpdir(), "core-admin-ai-pins-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const [
  { loadAiBudgets, loadAiClasses, loadAiProviders },
  { loadAiProjects, loadAiSkills },
  { loadAiPeople, loadAiUsage },
  { loadAiSettings },
] = await Promise.all([import("./catalog-data"), import("./content-data"), import("./insight-data"), import("./settings-data")]);

/**
 * Administration › KI: each section's server loader reads a fixed number of statements, however many providers,
 * models, rules, skills, projects and calls there are. The pins stay at the loaders, so they hold when the pages move.
 */

const admin = "c3000000-0000-4000-8000-000000000001";
const people = ["c3000000-0000-4000-8000-000000000002", "c3000000-0000-4000-8000-000000000003", "c3000000-0000-4000-8000-000000000004"];
const user: User = {
  id: admin,
  uid: "ai-admin",
  roles: ["admin"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Admin",
  displayName: "Ada Admin",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const subject = { actor: { kind: "user" as const, user }, accessSubject: { type: "user" as const, userId: admin } };
const input = (query: Record<string, string>): AiPageInput => ({
  locale: "de",
  query,
  url: "http://cloud.test/admin/ai",
  user,
  appNames: { mail: "Mail", spaces: "Spaces" },
  showAiJobsLink: true,
  dates: { locale: "de", timeZone: "Europe/Berlin", firstDayOfWeek: 1 },
});

/** What every section of the page reads first: the overview and the catalog. */
const overview = async () => {
  const [read, models, variants] = await Promise.all([readAiAdminOverview(), aiModelCatalog.models(), aiModelCatalog.variants()]);
  const index: AiCatalogIndex = { models, variants, assignments: read.assignments };
  return { overview: read, index };
};

/** Providers and models of one more kind, and the calls, skills and projects that come with more use. */
const grow = async (round: number) => {
  for (const provider of ["nord", "sued"]) {
    const id = `pins-${provider}-${round}`;
    await aiModelCatalog.createProvider({ id, type: "ollama", label: `Pins ${provider} ${round}`, dataBoundary: "private" }, admin);
    await aiModelCatalog.createModels(
      id,
      ["klein", "gross", "schnell"].map((size) => ({
        id: `${id}-${size}`,
        label: `${size} ${round}`,
        providerModel: `${size}:latest`,
        outputTokenLimit: 32_768,
      })),
      admin,
    );
  }
  for (const [index, person] of people.entries())
    await sql`INSERT INTO ai.inference_calls(id,user_id,model_profile_id,provider_model,kind,task,app_id,started_at,finished_at,lease_expires_at,input,output,pricing,cost,status)
      SELECT gen_random_uuid(),${person}::uuid,${`pins-nord-${round}-klein`},'klein:latest',CASE WHEN n%3=0 THEN 'background' ELSE 'chat' END,
        'pins-' || n%4,${index === 0 ? "mail" : "spaces"},now()-n*interval '1 hour',now()-n*interval '1 hour'+interval '2 seconds',now(),
        800,200,'{"inputPerMillion":1,"outputPerMillion":2}',0.0012,'ok' FROM generate_series(1,20) n`;
  for (const name of ["rechnungen-pruefen", "protokoll-schreiben", "angebot-entwerfen"])
    await aiSkills.create({
      subject,
      name: `${name}-${round}`,
      description: `Hilft bei ${name.replace("-", " ")} (${round}).`,
      instructions: `Arbeite Schritt für Schritt: ${name.replace("-", " ")}.`,
    });
  for (const name of ["Einkauf", "Vertrieb"])
    await aiProjects.create({ subject, name: `${name} ${round}`, description: `Projekt ${name}` });
};

let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
databaseSuite()("Administration › KI: statements per section loader (integration)", () => {
  beforeAll(async () => {
    database = await useMigratedDatabase("core_admin_ai_pins");
    await sql`CHECKPOINT`;
    registerSettings(toLegacySettingDefs(CORE_SETTINGS));
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin,display_name) VALUES(${admin}::uuid,'ai-admin','local','user',true,'Ada Admin')`;
    for (const [index, id] of people.entries())
      await sql`INSERT INTO auth.users(id,uid,provider,profile,display_name) VALUES(${id}::uuid,${`ai-person-${index}`},'local','user',${["Lea Muster", "Mia Wolf", "Tom Beispiel"][index]!})`;
    await grow(1);
    const config = await aiQuotas.config();
    await aiQuotas.save(
      {
        enabled: true,
        revision: config.revision,
        unit: "EUR",
        rules: [
          {
            scope: "*",
            hours: 24 * 30,
            anchor: "2026-01-01T00:00:00.000Z",
            grants: people.map((userId, index) => ({ principal: { type: "user" as const, userId }, limit: [5, 10, null][index] ?? null })),
          },
        ],
      },
      admin,
    );
  }, 180_000);

  const sections: [string, (catalog: Awaited<ReturnType<typeof overview>>) => Promise<unknown>][] = [
    ["classes", ({ index, overview }) => loadAiClasses(index, overview, parseAiAreaQuery({}))],
    ["class open", ({ index, overview }) => loadAiClasses(index, overview, parseAiAreaQuery({ sec: "classes", slot: "balanced" }))],
    ["providers", ({ index, overview }) => loadAiProviders(index, overview, parseAiAreaQuery({ sec: "providers" }))],
    ["provider open", ({ index, overview }) => loadAiProviders(index, overview, parseAiAreaQuery({ sec: "providers", p: "pins-nord-1" }))],
    [
      "model open",
      ({ index, overview }) =>
        loadAiProviders(index, overview, parseAiAreaQuery({ sec: "providers", p: "pins-nord-1", m: "pins-nord-1-klein" })),
    ],
    ["budgets", ({ index }) => loadAiBudgets(index)],
    ["budget brake", ({ index }) => loadAiBudgets(index, { brake: true })],
    ["people", () => loadAiPeople(input({ sec: "budgets", rule: "people" }))],
    ["general", () => loadAiSettings(input({ sec: "general" }), "general")],
    ["jobs", () => loadAiSettings(input({ sec: "jobs" }), "jobs")],
    ["tools", () => loadAiSettings(input({ sec: "tools" }), "tools")],
    ["skills", () => loadAiSkills(input({ sec: "skills" }))],
    ["projects", () => loadAiProjects(input({ sec: "projects" }))],
    ["usage", () => loadAiUsage(input({ sec: "usage" }))],
  ];

  /** The overview and each section loader, with the statements each one sends. */
  const measure = async () => {
    const meter = await meterSql();
    const report: Record<string, string[]> = {};
    try {
      // Warm the caches a running server holds, as every request after the first finds them.
      const warm = await overview();
      for (const [, load] of sections) await load(warm);
      let catalog = warm;
      report.overview = await meter.during(async () => {
        catalog = await overview();
      });
      for (const [name, load] of sections)
        report[name] = await meter.during(async () => {
          expect(await load(catalog)).toBeTruthy();
        });
    } finally {
      await meter.close();
    }
    return report;
  };

  test("each section loader costs a fixed number of statements, with more providers, models and use", async () => {
    const before = await measure();
    await grow(2);
    const after = await measure();
    const counts = (report: Record<string, string[]>) =>
      Object.fromEntries(Object.entries(report).map(([name, list]) => [name, list.length]));
    console.log(JSON.stringify({ before: counts(before), after: counts(after) }));
    // The overview still reads each provider's request headers on its own (aiModelCatalog.providers →
    // presentProvider → getAiRequestHeaders in @k2b/cloud): six statements and one per provider, two then four here.
    const fixed = {
      "class open": 2,
      classes: 0,
      providers: 0,
      "provider open": 4,
      "model open": 27,
      budgets: 17,
      "budget brake": 18,
      people: 18,
      general: 2,
      jobs: 4,
      tools: 2,
      skills: 4,
      projects: 3,
      usage: 22,
    };
    expect(counts(before)).toEqual({ overview: 6 + 2, ...fixed });
    expect(counts(after)).toEqual({ overview: 6 + 4, ...fixed });
    const headers = (report: Record<string, string[]>) =>
      report.overview!.filter((statement) => statement.startsWith("SELECT secret FROM ai.provider_request_headers")).length;
    expect([headers(before), headers(after)]).toEqual([2, 4]);
  }, 180_000);
});

// Imported fixtures may clean up at file scope; keep the database until they have finished.
afterAll(async () => {
  await database?.drop();
});
