import { expect, test } from "bun:test";
import { CodeActivityReadModelSchema, CodeRunReadModelSchema, CodeVersionReadModelSchema } from "@k2b/cloud/contracts";
import { codeUsesBoundChat } from "../bound-chat";
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
    personal: false,
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

test("an owner-data page needs its own approval; a public owner-data page stays a public page", () => {
  const page = (route: { public: boolean; audience?: "owner-data" }) => ({
    ...manifest,
    policyRows: [...(route.public ? (["public_routes"] as const) : []), ...(route.audience ? (["owner_data"] as const) : [])],
    entrypoints: [
      ...manifest.entrypoints,
      {
        kind: "route" as const,
        cron: null,
        entrypoint: "page",
        route: { method: "GET" as const, path: "/report", ...route },
        file: "code.ts",
        line: 3,
      },
    ],
  });
  for (const locale of ["de", "en"]) {
    const owner = present({ locale, manifest: page({ public: false, audience: "owner-data" }), policy: { owner_data: "admin" } });
    expect(owner.changes.approval?.count).toBe(1);
    expect(owner.changes.approval?.reason).toBe(
      locale === "de"
        ? "Diese Änderung zeigt allen Mitgliedern, die eine Seite öffnen, Daten mit den Rechten des Besitzers."
        : "This change shows the owner's data to every member who opens a page.",
    );
    expect(present({ locale, manifest: page({ public: false }), policy: { owner_data: "admin" } }).changes.approval).toBeNull();
    const open = page({ public: true, audience: "owner-data" });
    expect(present({ locale, manifest: open, policy: { owner_data: "admin" } }).changes.approval).toBeNull();
    expect(present({ locale, manifest: open, policy: { public_routes: "admin" } }).changes.approval?.count).toBe(1);
  }
});

test("unavailable readers hide free text without asserting that the reader lacks permission", () => {
  const model = present({ names: { ...names, target: () => ({ name: "ein Space", readable: false, unavailable: true }) } });
  expect(model.description.state).toBe("restricted");
  expect(model.description.text).toBe("Cloud zeigt die Beschreibung nicht, weil es nicht prüfen kann, ob du alle Ziele sehen darfst.");
  expect(JSON.stringify(model)).not.toMatch(/SECRET TARGET NAME|nicht sehen darfst/);
});

// P5 Rundgang m02: personal Code's own chat (chat.send to the bound chat, id null) hid its description from its owner.
test("the owner reads the description of personal Code that writes to its own chat; anyone else does not", () => {
  const chatSend = { operation: "core.ai.chat.send", target: { type: "core.ai.chat", id: null }, file: "code.ts", line: 1 };
  const withChat = { ...manifest, permissions: [...manifest.permissions, chatSend] };
  const dynamic = {
    ...names,
    target: (ref: { type: string; id: string | null }) =>
      ref.id === null ? { name: "ein Chat", readable: false, unavailable: true } : { name: "Space Logistik", readable: true },
  };
  const owner = present({
    personal: true,
    viewerIsOwner: true,
    manifest: withChat,
    comparison: withChat,
    names: dynamic,
    explanation: "Fasst die Aufgaben zusammen.",
  });
  expect(owner.description).toMatchObject({ state: "visible", text: "Fasst die Aufgaben zusammen." });
  const other = present({
    personal: true,
    runsAs: { name: "Lea Muster" },
    manifest: withChat,
    comparison: withChat,
    names: dynamic,
    explanation: "SECRET TARGET NAME",
  });
  expect(other.description.state).toBe("restricted");
  expect(JSON.stringify(other)).not.toContain("SECRET TARGET NAME");
  // A place's Code never treats an open chat target as its own, even with the flag set.
  expect(present({ viewerIsOwner: true, manifest: withChat, comparison: withChat, names: dynamic }).description.state).toBe("restricted");
  // Safe by default: a caller that names no reader, as a version card shown to another person or an admin, gets no
  // owner treatment, whether or not it says who the Code runs as.
  for (const viewerIsOwner of [undefined, false]) {
    const card = present({
      personal: true,
      ...(viewerIsOwner === undefined ? {} : { viewerIsOwner }),
      manifest: withChat,
      comparison: withChat,
      names: dynamic,
      explanation: "SECRET TARGET NAME",
    });
    expect(card.description.state).toBe("restricted");
    expect(JSON.stringify(card)).not.toContain("SECRET TARGET NAME");
  }
});

test("an explicit denial keeps its restriction even when another target is unavailable", () => {
  const permission = manifest.permissions[0]!;
  const model = present({
    manifest: { ...manifest, permissions: [permission, { ...permission, target: { type: "spaces.space", id: "denied" } }] },
    names: { ...names, target: (ref) => ({ name: "Space", readable: false, unavailable: ref.id !== "denied" }) },
  });
  expect(model.description.text).toBe("Die Beschreibung nennt Ziele, die du nicht sehen darfst");
});
test("dynamic target text remains hidden when no complete read-access proof is possible", () => {
  const permission = manifest.permissions[0]!;
  const model = present({
    manifest: { ...manifest, permissions: [{ ...permission, target: { type: "spaces.space", id: null } }] },
    names: { ...names, target: () => ({ name: "Space: wird beim Lauf gewählt", readable: false, unavailable: true }) },
  });
  expect(model.description.state).toBe("restricted");
  expect(JSON.stringify(model)).not.toContain("SECRET TARGET NAME");
  expect(model.description.text).not.toContain("nicht sehen darfst");
});

test("an unavailable static grant carries an independent reader reference and localized name slot", () => {
  for (const locale of ["de", "en"]) {
    const model = present({ locale, names: { ...names, target: () => ({ name: "Space", readable: false, unavailable: true }) } });
    expect(model.mayDo.items[0]).toMatchObject({
      text: "Aufgabe erstellen · Space",
      target: { ref: manifest.permissions[0]!.target, text: "Aufgabe erstellen · {name}" },
    });
    expect(CodeVersionReadModelSchema.parse(model)).toEqual(model);
    expect(JSON.stringify(model)).not.toContain("SECRET TARGET NAME");
  }
  expect(present().mayDo.items[0]).not.toHaveProperty("target");
  const dynamic = { ...manifest, permissions: [{ ...manifest.permissions[0]!, target: { type: "spaces.space", id: null } }] };
  expect(
    present({ manifest: dynamic, names: { ...names, target: () => ({ name: "Space", readable: false, unavailable: true }) } }).mayDo
      .items[0],
  ).not.toHaveProperty("target");
});

test.each(["de", "en"])("bound chat grants defer names and preserve permission comparisons in %s", (locale) => {
  const dynamic = {
    ...manifest,
    permissions: [{ ...manifest.permissions[0]!, operation: "core.ai.chat.send", target: { type: "core.ai.chat", id: null } }],
  };
  const input = { personal: true, manifest: dynamic, comparison: dynamic, locale, explanation: null };
  const boundChat = { type: "core.ai.chat", id: "cHt234" };
  const model = present({ ...input, boundChat });
  expect(model.mayDo.items).toEqual([
    {
      text: locale === "de" ? "In einen Chat schreiben, Gustav antwortet" : "Write to a chat, Gustav answers",
      note: locale === "de" ? "KI · mit deinen Rechten, zählt auf dein Kontingent" : "AI · with your rights, counts toward your allowance",
      target: {
        ref: boundChat,
        text: locale === "de" ? "In den Chat „{name}“ schreiben, Gustav antwortet" : "Write to the chat “{name}”, Gustav answers",
      },
    },
  ]);
  expect(CodeVersionReadModelSchema.parse(model)).toEqual(model);
  expect(model.changes).toEqual(present(input).changes);
  expect(model.changes.state).toBe("same");
  const nonPersonal = present({ ...input, personal: false, boundChat });
  expect(nonPersonal.mayDo.items[0]).not.toHaveProperty("note");
  expect(nonPersonal.mayDo.items[0]).not.toHaveProperty("target");
  for (const boundChat of [undefined, null]) {
    const unbound = present({ ...input, boundChat });
    expect(unbound.mayDo.items[0]?.text).toBe(model.mayDo.items[0]?.text);
    // The SDK's own handle marks the chat row for the page; it names no chat.
    expect(unbound.mayDo.items[0]?.target?.ref).toEqual({ type: "core.ai.chat", id: "bound-chat" });
  }
  const literal = present({
    ...input,
    boundChat,
    manifest: {
      ...dynamic,
      permissions: [{ ...manifest.permissions[0]!, operation: "core.ai.chat.send", target: { type: "core.ai.chat", id: "Other1" } }],
    },
  });
  expect(JSON.stringify(literal.mayDo)).not.toContain(boundChat.id);
});

// P6 Rundgang n02: Code that creates its own chat and writes there read as an automation still lacking its chat.
test("Code that creates its own chats offers no bound chat to choose", () => {
  const send = { ...manifest.permissions[0]!, operation: "core.ai.chat.send", target: { type: "core.ai.chat", id: null } };
  const create = { ...manifest.permissions[0]!, operation: "core.ai.chat.create", target: null };
  expect(codeUsesBoundChat([send])).toBe(true);
  expect(codeUsesBoundChat([create, send])).toBe(false);
  expect(codeUsesBoundChat([{ ...send, target: { type: "core.ai.chat", id: "Other1" } }])).toBe(false);
  const created = { ...manifest, permissions: [create, send] };
  const model = present({ personal: true, manifest: created, locale: "de", explanation: null, boundChat: null });
  const row = model.mayDo.items.find((item) => item.text === "In einen Chat schreiben, Gustav antwortet");
  expect(row).toBeDefined();
  expect(row).not.toHaveProperty("target");
});

test.each(["de", "en"])("shared personal Code names the execution owner, never the reader's allowance (%s)", (locale) => {
  const dynamic = {
    ...manifest,
    permissions: [{ ...manifest.permissions[0]!, operation: "core.ai.chat.send", target: { type: "core.ai.chat", id: null } }],
  };
  const model = present({ personal: true, runsAs: { name: "Lena" }, manifest: dynamic, locale });
  expect(model.mayDo.items[0]?.note).toBe(
    locale === "de" ? "KI · mit Lenas Rechten, zählt auf Lenas Kontingent" : "AI · with Lena’s rights, counts toward Lena’s allowance",
  );
  const hidden = present({ personal: true, runsAs: { name: null }, manifest: dynamic, locale });
  expect(hidden.mayDo.items[0]?.note).toBe(
    locale === "de"
      ? "KI · mit den Rechten der Person, der die Automation gehört, zählt auf deren Kontingent"
      : "AI · with the owner’s rights, counts toward their allowance",
  );
  expect(CodeVersionReadModelSchema.parse(model)).toEqual(model);
});
