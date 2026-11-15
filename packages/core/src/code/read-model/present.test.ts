import { expect, test } from "bun:test";
import { CodeActivityReadModelSchema, CodeRunReadModelSchema, CodeVersionReadModelSchema } from "@k2b/cloud/contracts";
import {
  codeActivityReadModelFixture,
  codeReadModelFixture,
  codeRunReadModelFixture,
  codeReadModelFixtureManifest as manifest,
} from "./fixtures";
import { presentCodeVersion, type ReadModelNames } from "./present";

const names: ReadModelNames = {
  target: () => ({ name: "ein Space, den du nicht sehen darfst", readable: false }),
  operation: () => ({ title: "Aufgabe erstellen" }),
  event: () => "eine Aufgabe fällig wird",
};
const present = (overrides: Partial<Parameters<typeof presentCodeVersion>[0]> = {}) =>
  presentCodeVersion({
    versionId: "00000000-0000-4000-8000-000000000001",
    number: 1,
    submittedAt: "2026-11-14T09:00:00.000Z",
    manifest,
    comparison: manifest,
    explanation: "SECRET TARGET NAME",
    evidence: {
      version: 1,
      tests: { state: "passed", passed: 1, total: 1, error: null },
      trial: null,
      examples: [{ name: "SECRET TARGET NAME", ok: true, sentences: { de: "SECRET TARGET NAME", en: "SECRET TARGET NAME" } }],
    },
    names,
    locale: "de",
    limits: { cases: 1 },
    ...overrides,
  });
test("one de/en model validates for Chat, Code, Waiting for you and administration", () => {
  for (const locale of ["de", "en"] as const) {
    expect(CodeVersionReadModelSchema.parse(codeReadModelFixture(locale))).toEqual(codeReadModelFixture(locale));
    expect(CodeRunReadModelSchema.parse(codeRunReadModelFixture(locale))).toEqual(codeRunReadModelFixture(locale));
    expect(CodeActivityReadModelSchema.parse(codeActivityReadModelFixture(locale))).toEqual(codeActivityReadModelFixture(locale));
  }
});
test("unreadable targets hide every free description, example name and example sentence", () => {
  const model = present();
  expect(model.description).toMatchObject({ state: "restricted", text: "Die Beschreibung nennt Ziele, die du nicht sehen darfst" });
  expect(JSON.stringify(model)).not.toContain("SECRET TARGET NAME");
  expect(JSON.stringify(model)).not.toContain("sp_fictional");
  expect(model.mayDo.items[0]?.text).toContain("ein Space, den du nicht sehen darfst");
});
test("model text never enters permissions or comparisons", () => {
  const input = { ...manifest, entrypoints: manifest.entrypoints.map((entry) => ({ ...entry, title: "SECRET MODEL CLAIM" })) };
  const model = present({ manifest: input });
  expect(JSON.stringify([model.mayDo, model.changes])).not.toMatch(/SECRET|MODEL CLAIM/);
});
test("same access and changed bundle has its own state without claiming unchanged behavior", () => {
  const model = present({ comparison: { ...manifest, hashes: { ...manifest.hashes, bundle: "d".repeat(64) } } });
  expect(model.changes.state).toBe("access_same_behavior_changed");
  expect(model.changes.text).toBe("Zugriffe gleich, Verhalten anders");
});
test("events read as sentences; all lists and examples keep their budgets", () => {
  const model = present({
    manifest: {
      ...manifest,
      entrypoints: [
        {
          kind: "event",
          entrypoint: "event:spaces.task.due@1",
          event: { type: "spaces.task.due", version: 1, place: { type: "spaces.space", id: "sp_fictional" } },
          cron: null,
          file: "code.ts",
          line: 1,
        },
      ],
      permissions: Array.from({ length: 54 }, (_, index) => ({ ...manifest.permissions[0]!, operation: `spaces.action${index}` })),
    },
  });
  expect(model.timing.items[0]?.text).toBe("Wenn das Ereignis „eine Aufgabe fällig wird“ eintritt · ein Space, den du nicht sehen darfst.");
  expect(model.mayDo.items).toHaveLength(50);
  expect(model.mayDo.moreText).toBe("4 weitere");
  expect(model.examples.items).toHaveLength(1);
});
test("status catalog uses explicit result words", () => {
  for (const locale of ["de", "en"] as const)
    for (const example of codeReadModelFixture(locale).examples.items) expect(example.status).not.toMatch(/^(Passt|OK|Gut|Fertig|Done)$/i);
});

test("an unavailable comparison has no misleading additions", () => {
  const model = present({ comparison: null, comparisonAvailable: false });
  expect(model.changes.state).toBe("unavailable");
  expect(model.changes.rows.items).toEqual([]);
  expect(
    present({
      comparison: null,
      comparisonAvailable: false,
      names: { ...names, operation: () => ({ title: "Action", policyRow: "silent_shared" }) },
      policy: { silent_shared: "admin" },
    }).changes.approval,
  ).toBeNull();
});

test("a missing model explanation leaves its section absent even with unreadable targets", () => {
  expect(present({ explanation: null }).description).toMatchObject({ state: "missing", text: null });
});

test("only added accesses at the effective admin policy carry approval causes and rebuild labels", () => {
  const names: ReadModelNames = {
    target: () => ({ name: "Visible folder", readable: true }),
    operation: () => ({ title: "Dateien ablegen", policyRow: "silent_shared" }),
    event: () => "Event",
  };
  for (const locale of ["de", "en"]) {
    const model = present({ names, locale, comparison: { ...manifest, permissions: [] }, policy: { silent_shared: "admin" } });
    expect(model.changes.rows.items.find((row) => row.kind === "add")).toMatchObject({
      requiresApproval: true,
      accessLabel: "Dateien ablegen",
    });
    expect(model.changes.approval?.count).toBe(1);
    expect(model.changes.approval?.reason).toContain(locale === "de" ? "andere sehen" : "other people");
    const multiple = present({
      names,
      locale,
      manifest: { ...manifest, permissions: [...manifest.permissions, { ...manifest.permissions[0]!, operation: "fictional.second" }] },
      comparison: { ...manifest, permissions: [] },
      policy: { silent_shared: "admin" },
    });
    expect(multiple.changes.approval?.withoutLabel).toBe(locale === "de" ? "Ohne Freigabe bauen" : "Build without approval");
    expect(present({ names, locale, policy: { silent_shared: "automatic" } }).changes.approval).toBeNull();
    expect(present({ names, locale, policy: { silent_shared: "never" } }).changes.approval).toBeNull();
  }
});

test("changed Internet, public-page and AI accesses retain one localized approval cause per access", () => {
  for (const locale of ["de", "en"]) {
    const input = {
      ...manifest,
      ai: true,
      policyRows: ["internet", "ai", "public_routes"] as const,
      internet: ["https://example.test"],
      permissions: [{ ...manifest.permissions[0]!, operation: "core.ai.decide" }],
      entrypoints: [
        ...manifest.entrypoints,
        {
          kind: "route" as const,
          cron: null,
          entrypoint: "page",
          route: { public: true, method: "GET" as const, path: "/report" },
          file: "code.ts",
          line: 3,
        },
      ],
    };
    const model = present({
      locale,
      manifest: { ...input, policyRows: [...input.policyRows] },
      comparison: { ...manifest, permissions: [] },
      names: { ...names, operation: () => ({ title: "AI decision", policyRow: "ai" }) },
      policy: { ai: "admin", internet: "admin", public_routes: "admin" },
    });
    expect(model.changes.approval?.count).toBe(3);
    expect(model.changes.rows.items.filter((row) => row.requiresApproval)).toHaveLength(3);
    expect(model.changes.approval?.withoutLabel).toBe(locale === "de" ? "Ohne Freigabe bauen" : "Build without approval");
  }
});
