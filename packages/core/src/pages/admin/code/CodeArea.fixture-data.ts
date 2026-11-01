/** Fictional data for render tests, browser tests and screenshots of Administration › Code. */
import type {
  CodeAdminApproval,
  CodeAdminApprovalDetail,
  CodeAdminCode,
  CodeAdminCodeDetail,
  CodeAdminDecided,
  CodeAdminEffective,
  CodeAdminPolicy,
  CodeAdminPolicyChange,
  CodeAdminSummary,
} from "../../../code/admin";
import type { CodeCleanupJob } from "../../../code/lifecycle-contracts";
import { codePolicyPreset } from "../../../code/policy-contracts";
import type { CodeRunnerMetrics } from "../../../code/scheduling-contracts";
import { CODE_SETTINGS } from "../../../code/settings";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import { CODE_LIMIT_KEYS } from "./area";
import type { CodeAreaData } from "./view";

const h = (seed: string) => seed.repeat(64).slice(0, 64);
/** Freshness values are relative to now, so screenshots read "4 minutes ago" on any day. */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
export const FIXTURE_PEOPLE = {
  ben: "11111111-1111-4111-8111-111111111111",
  lea: "22222222-2222-4222-8222-222222222222",
  tom: "33333333-3333-4333-8333-333333333333",
  jana: "44444444-4444-4444-8444-444444444444",
  mia: "55555555-5555-4555-8555-555555555555",
} as const;
export const FIXTURE_GROUPS = { buchhaltung: "66666666-6666-4666-8666-666666666666", praktikum: "77777777-7777-4777-8777-777777777777" };
const V = {
  rueckruf3: "a0000000-0000-4000-8000-000000000003",
  rueckruf2: "a0000000-0000-4000-8000-000000000002",
  rueckruf4: "a0000000-0000-4000-8000-000000000004",
  lieferzeit1: "b0000000-0000-4000-8000-000000000001",
  rechnungen2: "c0000000-0000-4000-8000-000000000002",
  wochenbericht3: "d0000000-0000-4000-8000-000000000003",
};
export const FIXTURE_VERSIONS = V;

export const fixtureSummary = (): CodeAdminSummary => ({ approvals: 4, codes: 8, groups: 2, cleanup: 2 });

export const fixtureApprovals = (): CodeAdminApproval[] => [
  {
    approvalId: "e0000000-0000-4000-8000-000000000001",
    codeId: "c_rueck",
    versionId: V.rueckruf3,
    number: 3,
    title: "Rückruf bestätigen",
    author: { id: FIXTURE_PEOPLE.lea, name: "Lea Muster" },
    submittedAt: "2026-11-01T11:10:00.000Z",
    rows: ["ask_involves_people"],
    stat: { first: false, added: 3, removed: 1, lines: 41, files: 1 },
  },
  {
    approvalId: "e0000000-0000-4000-8000-000000000002",
    codeId: "c_liefer",
    versionId: V.lieferzeit1,
    number: 1,
    title: "Lieferzeit beantworten",
    author: { id: FIXTURE_PEOPLE.tom, name: "Tom Beispiel" },
    submittedAt: "2026-11-01T08:10:00.000Z",
    rows: ["silent_shared"],
    stat: { first: true, added: 20, removed: 0, lines: 20, files: 1 },
  },
  {
    approvalId: "e0000000-0000-4000-8000-000000000003",
    codeId: "c_rechn",
    versionId: V.rechnungen2,
    number: 2,
    title: "Rechnungen an die Buchhaltung",
    author: { id: FIXTURE_PEOPLE.tom, name: "Tom Beispiel" },
    submittedAt: "2026-10-31T15:42:00.000Z",
    rows: ["internet"],
    stat: { first: false, added: 2, removed: 1, lines: 28, files: 1 },
  },
  {
    approvalId: "e0000000-0000-4000-8000-000000000004",
    codeId: "c_woche",
    versionId: V.wochenbericht3,
    number: 3,
    title: "Wochenbericht Vertrieb",
    author: { id: FIXTURE_PEOPLE.lea, name: "Lea Muster" },
    submittedAt: "2026-10-31T09:05:00.000Z",
    rows: ["ask_keeps_working"],
    stat: { first: false, added: null, removed: null, lines: 64, files: 2 },
  },
];

export const fixtureDecided = (): CodeAdminDecided[] => [
  {
    codeId: "c_termin",
    versionId: "f0000000-0000-4000-8000-000000000001",
    number: 2,
    title: "Termin-Antworten",
    approved: true,
    soleAdmin: false,
    decidedBy: "Ben Schulz",
    decidedAt: "2026-10-30T10:00:00.000Z",
  },
  {
    codeId: "c_portal",
    versionId: "f0000000-0000-4000-8000-000000000002",
    number: 1,
    title: "Kundenportal-Eingang",
    approved: false,
    soleAdmin: false,
    decidedBy: "Jana Probe",
    decidedAt: "2026-10-29T14:20:00.000Z",
  },
  {
    codeId: "c_anfrag",
    versionId: "f0000000-0000-4000-8000-000000000003",
    number: 4,
    title: "Anfragen sortieren",
    approved: true,
    soleAdmin: true,
    decidedBy: "Ben Schulz",
    decidedAt: "2026-10-21T08:30:00.000Z",
  },
];

const before = `import { app, ai, owner } from "@sdk";

// Bei neuer Mail in info@ (der Besitzer dieses Codes)
app.schedule("*/15 * * * *", async () => {
  const messages = await owner.message.list({ unread: true });
  for (const msg of messages) {
    if (msg.labels.includes("Newsletter")) continue;
    const kind = await ai.classify({ text: msg.text, labels: ["Rückruf", "Sonstiges"] });
    if (kind !== "Rückruf") continue;
    await owner.draft.create({ replyTo: msg.id, text: "Wir rufen Sie zurück." });
  }
});`;
const after = `import { app, ai, owner, spaces } from "@sdk";

// Bei neuer Mail in info@ (der Besitzer dieses Codes)
app.schedule("*/15 * * * *", async () => {
  const messages = await owner.message.list({ unread: true });
  for (const msg of messages) {
    if (msg.labels.includes("Newsletter")) continue;
    if (msg.from.noReply) continue; // keine Antwort an no-reply-Adressen
    const kind = await ai.classify({ text: msg.text, labels: ["Rückruf", "Sonstiges"] });
    if (kind !== "Rückruf") continue;
    await spaces.space("sp_2lg8").task.create({ title: \`Rückruf: \${msg.from.name}\`, idempotencyKey: msg.id });
    await owner.conversation.tag({ conversationId: msg.conversationId, add: ["Rückruf"] });
  }
});`;
const diffLines = () => {
  const old = before.split("\n");
  const neu = after.split("\n");
  const rows: { kind: "same" | "add" | "del"; text: string }[] = [];
  rows.push(
    ...neu.slice(0, 6).map((text, i) => ({ kind: i === 0 ? ("del" as const) : ("same" as const), text: i === 0 ? old[0]! : text })),
  );
  rows.splice(1, 0, { kind: "add", text: neu[0]! });
  rows.push({ kind: "add", text: neu[6]! });
  rows.push({ kind: "same", text: neu[7]! }, { kind: "same", text: neu[8]! });
  rows.push({ kind: "del", text: old[8]! });
  rows.push({ kind: "add", text: neu[9]! }, { kind: "add", text: neu[10]! });
  rows.push(...neu.slice(11).map((text) => ({ kind: "same" as const, text })));
  return rows;
};

export const fixtureApprovalDetail = (
  variant: "normal" | "first" | "newer" | "own" | "sole" | "difffail" | "approved" | "rejected" = "normal",
): CodeAdminApprovalDetail => {
  const first = variant === "first";
  return {
    approvalId: "e0000000-0000-4000-8000-000000000001",
    status: variant === "approved" ? "approved" : variant === "rejected" ? "rejected" : "pending",
    code: {
      id: first ? "c_liefer" : "c_rueck",
      title: first ? "Lieferzeit beantworten" : "Rückruf bestätigen",
      owner: { kind: "resource", ref: { type: "mail.mailbox", id: "m_info" } },
      state: "active",
    },
    ownerName: null,
    version: {
      id: first ? V.lieferzeit1 : V.rueckruf3,
      number: first ? 1 : 3,
      submittedAt: first ? "2026-11-01T08:10:00.000Z" : "2026-11-01T11:10:00.000Z",
      author:
        variant === "own" || variant === "sole"
          ? { id: FIXTURE_PEOPLE.ben, name: "Ben Schulz" }
          : first
            ? { id: FIXTURE_PEOPLE.tom, name: "Tom Beispiel" }
            : { id: FIXTURE_PEOPLE.lea, name: "Lea Muster" },
    },
    binding: {
      codeId: first ? "c_liefer" : "c_rueck",
      versionId: first ? V.lieferzeit1 : V.rueckruf3,
      sourceHash: h("91ad4c"),
      bundleHash: h("7c2ef0"),
      manifestHash: h("5b1e"),
      comparisonVersionId: first ? null : V.rueckruf2,
      comparisonSourceHash: first ? null : h("44aa"),
      comparisonBundleHash: first ? null : h("19c0"),
    },
    comparison: first ? null : { versionId: V.rueckruf2, number: 2, decidedAt: "2026-10-21T09:00:00.000Z", decidedBy: "Ben Schulz" },
    files:
      variant === "difffail"
        ? null
        : first
          ? [{ path: "code.ts", lines: before.split("\n").map((text) => ({ kind: "add" as const, text })) }]
          : [
              { path: "code.ts", lines: diffLines() },
              {
                path: "code.test.ts",
                lines: ['import { test } from "@sdk/test";', "", 'test("Rückruf", async () => {});'].map((text) => ({
                  kind: "same" as const,
                  text,
                })),
              },
            ],
    staleComparison: false,
    permissions: first
      ? [
          { operation: "mail.message.list", target: { type: "mail.mailbox", id: "m_info" }, file: "code.ts", line: 5, change: "added" },
          { operation: "mail.draft.create", target: { type: "mail.mailbox", id: "m_info" }, file: "code.ts", line: 10, change: "added" },
        ]
      : [
          { operation: "spaces.task.create", target: { type: "spaces.space", id: "sp_2lg8" }, file: "code.ts", line: 11, change: "added" },
          {
            operation: "mail.conversation.tag",
            target: { type: "mail.mailbox", id: "m_info" },
            file: "code.ts",
            line: 12,
            change: "added",
          },
          { operation: "mail.message.list", target: { type: "mail.mailbox", id: "m_info" }, file: "code.ts", line: 5, change: "same" },
          { operation: "mail.draft.create", target: { type: "mail.mailbox", id: "m_info" }, file: "code.ts", line: 10, change: "removed" },
        ],
    why: [{ row: "ask_involves_people", source: "default", groups: [] }],
    ai: true,
    newer:
      variant === "newer" ? { versionId: V.rueckruf4, number: 4, author: "Lea Muster", submittedAt: "2026-11-01T11:40:00.000Z" } : null,
    canApprove: variant !== "own",
    own: variant === "own" || variant === "sole",
    soleAdminNotice: variant === "sole" ? "Du gibst deinen eigenen Code frei. Es gibt keinen zweiten Cloud-Admin, der ihn prüft." : null,
    decision:
      variant === "approved"
        ? {
            approved: true,
            soleAdmin: false,
            decidedBy: FIXTURE_PEOPLE.ben,
            decidedAt: "2026-11-01T12:20:00.000Z",
            label: "",
            decidedByName: "Ben Schulz",
          }
        : null,
    evidence: first
      ? {
          version: 1,
          tests: { state: "passed", passed: 7, total: 7, error: null },
          trial: { runs: 7, calls: [{ operation: "mail.draft.create", count: 4 }] },
        }
      : {
          version: 1,
          tests: { state: "passed", passed: 9, total: 9, error: null },
          trial: {
            runs: 9,
            calls: [
              { operation: "spaces.task.create", count: 6 },
              { operation: "mail.message.list", count: 9 },
            ],
          },
        },
    comparisonEvidence: first
      ? null
      : {
          version: 1,
          tests: { state: "passed", passed: 7, total: 7, error: null },
          trial: {
            runs: 7,
            calls: [
              { operation: "mail.draft.create", count: 6 },
              { operation: "mail.message.list", count: 7 },
            ],
          },
        },
    explanation: first
      ? "Fragt jemand in info@ nach einer Lieferzeit, legt der Code einen Entwurf mit der Antwort an."
      : "Bittet jemand in info@ um Rückruf, legt der Code eine Aufgabe in Space Logistik an und taggt die Unterhaltung.",
    internet: first ? [] : ["https://api.buchhaltung-beispiel.de", "https://bank.example", "https://status.example:8443"],
    secrets: first
      ? []
      : [
          {
            name: "BUCHHALTUNG_TOKEN",
            origin: "https://api.buchhaltung-beispiel.de",
            pathPrefix: "/v1",
            headers: ["authorization"],
            binding_revision: "a0000000-0000-4000-8000-000000000001",
          },
        ],
    titles: {
      operations: {
        "spaces.task.create": "Aufgabe anlegen",
        "mail.conversation.tag": "Unterhaltung taggen",
        "mail.message.list": "Mails auflisten",
        "mail.draft.create": "Entwurf anlegen",
      },
      types: { "spaces.space": "Space", "mail.mailbox": "Postfach" },
    },
  };
};

const code = (
  id: string,
  title: string,
  owner: CodeAdminCode["owner"],
  ownerName: string | null,
  status: CodeAdminCode["status"],
  lastRun: string | null,
  pauseReason: string | null = null,
): CodeAdminCode => ({
  id,
  title,
  owner,
  ownerName,
  state: status === "waiting" ? "active" : status,
  status,
  pauseReason,
  lastRun: lastRun ? { at: lastRun, state: "succeeded" } : null,
});
export const fixtureCodes = (): CodeAdminCode[] => [
  code("c_anfrag", "Anfragen sortieren", { kind: "resource", ref: { type: "mail.mailbox", id: "m_info" } }, null, "active", ago(4)),
  code("c_auftrag", "Auftragsboard", { kind: "person", userId: FIXTURE_PEOPLE.mia }, "Mia Koch", "active", ago(70)),
  code("c_portal", "Kundenportal-Eingang", { kind: "app", appId: "werkstatt" }, null, "draft", null),
  code(
    "c_liefer",
    "Lieferschein bei Abschluss",
    { kind: "person", userId: FIXTURE_PEOPLE.tom },
    "Tom Beispiel",
    "paused",
    ago(60 * 26),
    "policy_changed",
  ),
  code(
    "c_rechn",
    "Rechnungen an die Buchhaltung",
    { kind: "resource", ref: { type: "mail.mailbox", id: "m_rechn" } },
    null,
    "waiting",
    ago(12),
  ),
  code("c_rueck", "Rückruf bestätigen", { kind: "resource", ref: { type: "mail.mailbox", id: "m_info" } }, null, "waiting", ago(9)),
  code("c_termin", "Termin-Antworten", { kind: "person", userId: FIXTURE_PEOPLE.lea }, "Lea Muster", "active", ago(60)),
  code(
    "c_woche",
    "Wochenbericht Vertrieb",
    { kind: "person", userId: FIXTURE_PEOPLE.lea },
    "Lea Muster",
    "paused",
    ago(60 * 24 * 5),
    "policy_changed",
  ),
];
export const fixtureCodeDetail = (codeId = "c_rechn"): CodeAdminCodeDetail => {
  const base = fixtureCodes().find((code) => code.id === codeId) ?? fixtureCodes()[4]!;
  return {
    code: { ...base, activeVersionNumber: 1, createdAt: "2026-10-20T09:00:00.000Z" },
    pendingVersionId: V.rechnungen2,
    versions: [
      {
        version: {
          id: V.rechnungen2,
          codeId: base.id,
          number: 2,
          sourceHash: h("aa"),
          bundleHash: h("bb"),
          files: ["code.ts"],
          sourceBytes: 1200,
          bundleBytes: 3400,
          manifestAvailable: true,
          createdBy: FIXTURE_PEOPLE.tom,
          createdAt: "2026-10-31T15:42:00.000Z",
        },
        binding: {
          codeId: base.id,
          versionId: V.rechnungen2,
          sourceHash: h("aa"),
          bundleHash: h("bb"),
          manifestHash: h("cc"),
          comparisonVersionId: null,
          comparisonSourceHash: null,
          comparisonBundleHash: null,
        },
        status: "pending",
        approvalId: "e0000000-0000-4000-8000-000000000003",
        decision: null,
      },
      {
        version: {
          id: "c0000000-0000-4000-8000-000000000001",
          codeId: base.id,
          number: 1,
          sourceHash: h("dd"),
          bundleHash: h("ee"),
          files: ["code.ts"],
          sourceBytes: 1100,
          bundleBytes: 3300,
          manifestAvailable: true,
          createdBy: FIXTURE_PEOPLE.tom,
          createdAt: "2026-10-20T09:00:00.000Z",
        },
        binding: {
          codeId: base.id,
          versionId: "c0000000-0000-4000-8000-000000000001",
          sourceHash: h("dd"),
          bundleHash: h("ee"),
          manifestHash: h("ff"),
          comparisonVersionId: null,
          comparisonSourceHash: null,
          comparisonBundleHash: null,
        },
        status: "approved",
        approvalId: null,
        decision: {
          approved: true,
          soleAdmin: true,
          decidedBy: FIXTURE_PEOPLE.ben,
          decidedAt: "2026-10-20T10:00:00.000Z",
          label: "Selbst freigegeben (einziger Admin)",
        },
      },
    ],
    runs: [
      {
        id: "90000000-0000-4000-8000-000000000001",
        codeId: base.id,
        versionId: "c0000000-0000-4000-8000-000000000001",
        trigger: "schedule",
        entrypoint: "default",
        state: "succeeded",
        outcome: "succeeded",
        createdAt: "2026-11-01T07:42:00.000Z",
        startedAt: "2026-11-01T07:42:01.000Z",
        endedAt: "2026-11-01T07:42:03.000Z",
        rerunOf: null,
        rerunByName: null,
      },
      {
        id: "90000000-0000-4000-8000-000000000002",
        codeId: base.id,
        versionId: "c0000000-0000-4000-8000-000000000001",
        trigger: "manual",
        entrypoint: "default",
        state: "failed",
        outcome: "failed",
        createdAt: "2026-10-31T16:10:00.000Z",
        startedAt: "2026-10-31T16:10:01.000Z",
        endedAt: "2026-10-31T16:10:02.000Z",
        rerunOf: null,
        rerunByName: null,
      },
    ],
    cleanup: [],
  };
};

export const fixturePolicy = (): CodeAdminPolicy => {
  const definition = codePolicyPreset("admin");
  definition.preset = "custom";
  definition.rules.push(
    { groupId: FIXTURE_GROUPS.buchhaltung, row: "ask_deletes", value: "automatic" },
    { groupId: FIXTURE_GROUPS.buchhaltung, row: "silent_shared", value: "automatic" },
    { groupId: FIXTURE_GROUPS.praktikum, row: "ask_sends", value: "never" },
    { groupId: FIXTURE_GROUPS.praktikum, row: "internet", value: "never" },
  );
  return {
    policy: { revision: 7, definition, updatedBy: FIXTURE_PEOPLE.jana, updatedAt: "2026-10-30T14:00:00.000Z" },
    updatedByName: "Jana Probe",
    usage: {
      read: 7,
      silent_you: 3,
      silent_draft: 2,
      silent_shared: 4,
      ask_deletes: 1,
      ask_involves_people: 2,
      ask_keeps_working: 1,
      ai: 5,
      internet: 2,
    },
    groups: [
      { id: FIXTURE_GROUPS.buchhaltung, name: "Buchhaltung", rules: 2, members: 6, parents: ["Verwaltung"] },
      { id: FIXTURE_GROUPS.praktikum, name: "Praktikum", rules: 2, members: 3, parents: [] },
    ],
  };
};

export const fixtureEffective = (): CodeAdminEffective => ({
  person: { id: FIXTURE_PEOPLE.tom, name: "Tom Beispiel" },
  groups: [
    { id: FIXTURE_GROUPS.buchhaltung, name: "Buchhaltung", parents: ["Verwaltung"] },
    { id: FIXTURE_GROUPS.praktikum, name: "Praktikum", parents: [] },
  ],
  rows: [
    { row: "read", value: "automatic", source: "default", groups: [] },
    { row: "silent_you", value: "automatic", source: "default", groups: [] },
    { row: "silent_draft", value: "automatic", source: "default", groups: [] },
    { row: "silent_shared", value: "automatic", source: "group", groups: ["Buchhaltung"] },
    { row: "ask_sends", value: "never", source: "veto", groups: ["Praktikum"] },
    { row: "ask_deletes", value: "automatic", source: "group", groups: ["Buchhaltung"] },
    { row: "ask_cannot_undo", value: "admin", source: "default", groups: [] },
    { row: "ask_involves_people", value: "admin", source: "default", groups: [] },
    { row: "ask_changes_access", value: "admin", source: "default", groups: [] },
    { row: "ask_keeps_working", value: "admin", source: "default", groups: [] },
    { row: "ask_sensitive", value: "admin", source: "default", groups: [] },
    { row: "ask_app_asks", value: "admin", source: "default", groups: [] },
    { row: "ai", value: "admin", source: "default", groups: [] },
    { row: "internet", value: "never", source: "veto", groups: ["Praktikum"] },
  ],
});

export const fixtureCleanup = (): CodeCleanupJob[] => [
  {
    id: "70000000-0000-4000-8000-000000000001",
    codeId: "c_altpost",
    title: "Code von alt@",
    kind: "code.access.rm",
    grantId: "71000000-0000-4000-8000-000000000001",
    target: { type: "spaces.space", id: "sp_2lg8" },
    state: "waiting",
    attempts: 3,
    lastError: "target_unreachable",
    nextAttemptAt: "2026-11-01T12:30:00.000Z",
    createdAt: "2026-11-01T09:00:00.000Z",
  },
  {
    id: "70000000-0000-4000-8000-000000000002",
    codeId: "c_altpost",
    title: "Code von alt@",
    kind: "code.delete",
    grantId: null,
    target: null,
    state: "pending",
    attempts: 0,
    lastError: null,
    nextAttemptAt: "2026-11-01T09:00:00.000Z",
    createdAt: "2026-11-01T09:00:00.000Z",
  },
];

export const fixtureRunners = (empty = false): CodeRunnerMetrics =>
  empty
    ? { queued: 3, running: 0, oldestWaitingMs: 95_000, instances: 0, freeSlots: 0, runners: [], nextCursor: null }
    : {
        queued: 5,
        running: 7,
        oldestWaitingMs: 4_200,
        instances: 3,
        freeSlots: 5,
        runners: [
          { instanceId: "8a3c1e20-5d1b-4c2f-9a10-1b2c3d4e5f60", freeSlots: 1, lastSeenAt: new Date(Date.now() - 8_000).toISOString() },
          { instanceId: "9b4d2f31-6e2c-4d30-8b21-2c3d4e5f6071", freeSlots: 0, lastSeenAt: new Date(Date.now() - 5_000).toISOString() },
          { instanceId: "ac5e3042-7f3d-4e41-9c32-3d4e5f607182", freeSlots: 4, lastSeenAt: new Date(Date.now() - 2_000).toISOString() },
        ],
        nextCursor: null,
      };

export const fixtureHistory = (): CodeAdminPolicyChange[] => [
  {
    at: "2026-10-30T14:00:00.000Z",
    by: "Jana Probe",
    revision: 7,
    preset: null,
    changes: [
      { group: "Praktikum", row: "ask_sends", before: null, after: "never" },
      { group: "Praktikum", row: "internet", before: null, after: "never" },
    ],
  },
  {
    at: "2026-10-28T09:12:00.000Z",
    by: "Ben Schulz",
    revision: 6,
    preset: { before: "admin", after: "custom" },
    changes: [{ group: null, row: "silent_shared", before: "automatic", after: "admin" }],
  },
  {
    at: "2026-10-20T08:00:00.000Z",
    by: "Jana Probe",
    revision: 5,
    preset: { before: "open", after: "admin" },
    changes: (
      [
        "silent_shared",
        "ask_deletes",
        "ask_cannot_undo",
        "ask_involves_people",
        "ask_changes_access",
        "ask_keeps_working",
        "ask_sensitive",
      ] as const
    ).map((row) => ({ group: null, row, before: "automatic" as const, after: "admin" as const })),
  },
];

/** Every part loaded; tests replace single parts to reach a state. */
export const fixtureData = (): CodeAreaData => ({
  summary: fixtureSummary(),
  approvals: { items: fixtureApprovals(), nextCursor: null },
  decided: fixtureDecided(),
  approval: null,
  codes: { items: fixtureCodes(), total: 8, owners: 5, nextCursor: null },
  code: null,
  source: null,
  policy: fixturePolicy(),
  effective: null,
  history: fixtureHistory(),
  cleanup: { items: fixtureCleanup(), nextCursor: null },
  runners: fixtureRunners(),
  limits: [],
});

/** States the captures and tests switch with `?state=`. */
export const CODE_FIXTURE_STATES = [
  "normal",
  "empty",
  "fail",
  "noperm",
  "first",
  "newer",
  "own",
  "sole",
  "difffail",
  "approved",
  "missing",
  "conflict",
  "savefail",
  "saving",
  "lost",
] as const;
export type CodeFixtureState = (typeof CODE_FIXTURE_STATES)[number];

const limitEntries = (locale: string): SettingFieldDef[] =>
  [...CODE_LIMIT_KEYS].map((key) => {
    const definition = CODE_SETTINGS[key];
    const de = definition.presentation.translations.de;
    return {
      key,
      label: locale === "de" ? de.label : definition.label,
      description: locale === "de" ? de.description : definition.description,
      kind: "number",
      value: definition.default,
      default: definition.default,
      resetValue: definition.default,
      valueSource: "default",
      resetValueSource: "default",
      isCustom: false,
      unreadable: false,
      group: "core",
      min: definition.min,
      max: definition.max,
    };
  });

/** The page data for one fixture state and URL. */
export function codeFixtureData(state: CodeFixtureState, query: Record<string, string | undefined>, locale = "de"): CodeAreaData {
  const data = fixtureData();
  data.limits = limitEntries(locale);
  if (state === "empty")
    return {
      ...data,
      summary: { approvals: 0, codes: 0, groups: 0, cleanup: 0 },
      approvals: { items: [], nextCursor: null },
      decided: [],
      codes: { items: [], total: 0, owners: 0, nextCursor: null },
      cleanup: { items: [], nextCursor: null },
      history: [],
      runners: fixtureRunners(true),
      policy: data.policy !== null && data.policy !== "failed" && data.policy !== "missing" ? { ...data.policy, groups: [] } : data.policy,
    };
  if (state === "fail")
    return {
      ...data,
      approvals: "failed",
      decided: "failed",
      codes: "failed",
      policy: "failed",
      cleanup: "failed",
      history: "failed",
      runners: "failed",
      limits: "failed",
      ...(query.sec === "code" && query.id
        ? { code: fixtureCodeDetail(query.id), source: query.version ? ("failed" as const) : null }
        : {}),
    };
  if (query.sec === "approvals" && query.id) {
    const variant = query.id === FIXTURE_VERSIONS.lieferzeit1 ? "first" : state;
    data.approval =
      state === "missing"
        ? "missing"
        : fixtureApprovalDetail(
            variant === "first" ||
              variant === "newer" ||
              variant === "own" ||
              variant === "sole" ||
              variant === "difffail" ||
              variant === "approved"
              ? variant
              : "normal",
          );
  }
  if (query.sec === "code" && query.id) data.code = state === "missing" ? "missing" : fixtureCodeDetail(query.id);
  if (query.sec === "code" && query.id && query.version)
    data.source =
      state === "missing"
        ? "missing"
        : {
            versionId: query.version,
            number: 2,
            bundleHash: h("bb"),
            files: [{ path: "code.ts", lines: before.split("\n").map((text) => ({ kind: "add" as const, text })) }],
          };
  if (query.sec === "code" && query.status) {
    const codes = data.codes;
    if (codes !== null && codes !== "failed" && codes !== "missing")
      data.codes = {
        ...codes,
        items: codes.items.filter((code) => code.status === query.status),
        total: codes.items.filter((code) => code.status === query.status).length,
      };
  }
  if (query.sec === "effective" && query.id) data.effective = state === "missing" ? "missing" : fixtureEffective();
  return data;
}
