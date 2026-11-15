import type { CodeCheckedVersionManifest } from "@k2b/cloud/contracts";
import type { ReadModelNames } from "./present";
import { presentCodeVersion } from "./present";

/** Fictional, deterministic fixtures shared by render tests of every consumer. */
export const codeReadModelFixtureManifest: CodeCheckedVersionManifest = {
  version: 1,
  entry: "code.ts",
  ai: false,
  policyRows: ["silent_you"],
  entrypoints: [{ kind: "schedule", entrypoint: "daily", cron: "0 9 * * *", file: "code.ts", line: 1 }],
  permissions: [{ operation: "spaces.task.create", target: { type: "spaces.space", id: "sp_fictional" }, file: "code.ts", line: 2 }],
  hashes: { source: "a".repeat(64), bundle: "b".repeat(64), sdk: "c".repeat(64) },
};
export function codeReadModelFixture(locale: "de" | "en") {
  const names: ReadModelNames = {
    target: () => ({ name: locale === "de" ? "Team Logistik" : "Logistics team", readable: true, href: "/spaces/fictional" }),
    operation: () => ({ title: locale === "de" ? "Aufgabe erstellen" : "Create task", app: "Spaces", icon: "tabler:layout-kanban" }),
    event: () => (locale === "de" ? "eine Aufgabe fällig wird" : "a task becomes due"),
  };
  return presentCodeVersion({
    versionId: "00000000-0000-4000-8000-000000000001",
    number: 5,
    submittedAt: "2026-11-14T09:00:00.000Z",
    manifest: codeReadModelFixtureManifest,
    comparison: { ...codeReadModelFixtureManifest, permissions: [] },
    names,
    locale,
    explanation:
      locale === "de" ? "Sie legt morgens eine Aufgabe im Team Logistik an." : "It creates a task for the Logistics team every morning.",
    evidence: {
      version: 1,
      tests: { state: "passed", passed: 3, total: 3, error: null },
      trial: null,
      examples: [1, 2, 3].map((number) => ({
        name: locale === "de" ? `Morgenrunde ${number}` : `Morning round ${number}`,
        ok: true,
        sentences: { de: "Eine Aufgabe erstellt.", en: "Created one task." },
      })),
    },
    limits: { cases: 64 },
  });
}

/** Fixed run and activity snapshots for the Code page and My Apps timeline fixtures. */
export function codeRunReadModelFixture(locale: "de" | "en"): import("@k2b/cloud/contracts").CodeRunReadModel {
  const de = locale === "de";
  return {
    runId: "00000000-0000-4000-8000-000000000002",
    title: de ? "Aufgabe erstellen · 3 bestätigt" : "Create task · 3 confirmed",
    state: "succeeded",
    status: de ? "Erfolgreich" : "Successful",
    at: "2026-11-14T09:00:00.000Z",
    reason: null,
    untilThen: { items: [{ text: de ? "Aufgabe erstellen · 3 bestätigt" : "Create task · 3 confirmed" }], more: 0, moreText: null },
    complete: true,
  };
}
export function codeActivityReadModelFixture(locale: "de" | "en"): import("@k2b/cloud/contracts").CodeActivityReadModel {
  const run = codeRunReadModelFixture(locale);
  return {
    week: "2026-11-09T00:00:00.000Z",
    counters: { items: [{ key: "spaces.task.create", automationKey: "daily", text: run.title, count: 3 }], more: 0, moreText: null },
    recent: [
      {
        text: locale === "de" ? "Aufgabe erstellen · 1 bestätigt" : "Create task · 1 confirmed",
        at: run.at,
        href: "/spaces/fictional",
        runId: run.runId,
      },
    ],
    timeline: {
      from: "2026-11-13T23:00:00.000Z",
      to: "2026-11-14T23:00:00.000Z",
      total: 2,
      marks: [
        { at: run.at, state: "succeeded", count: 1, runId: run.runId },
        { at: "2026-11-14T17:00:00.000Z", state: "planned", count: 1 },
      ],
    },
  };
}
