import type { CodeDiffLine } from "@k2b/ui";
import { type CodeSourceTabInitial, type CodeSourceTabVersion, compareRows } from "./source-tab-load";

/**
 * Fictional states of the Code tab for render tests and screenshots, after the approved mockup (`#code-code`):
 * version 4 of the automation of info@moebel-beispiel.de is switched on; versions 1 to 3 came before it.
 */
export const SOURCE_TAB_ENABLED = { id: "00000000-0000-4000-8000-000000000004", number: 4, files: ["code.ts", "seite.tsx"] };
const VERSION_3: CodeSourceTabVersion = {
  versionId: "00000000-0000-4000-8000-000000000003",
  number: 3,
  submittedAt: "2026-10-21T08:12:00.000Z",
};
const VERSION_1: CodeSourceTabVersion = {
  versionId: "00000000-0000-4000-8000-000000000001",
  number: 1,
  submittedAt: "2026-10-07T15:05:00.000Z",
};
export const SOURCE_TAB_VERSIONS: CodeSourceTabVersion[] = [
  VERSION_3,
  { versionId: "00000000-0000-4000-8000-000000000002", number: 2, submittedAt: "2026-10-14T09:40:00.000Z" },
  VERSION_1,
];

const head = [
  'import { app, owner, spaces } from "@sdk";',
  "",
  'const logistik = spaces.space("sp_logistik");',
  "",
  'app.schedule({ name: "werktags", cron: "0 8 * * 1-5" }, async () => {',
  '  const offen = await owner.message.list({ folder: "Eingang", unread: true });',
  "  for (const mail of offen) {",
];
const removed = ["    await owner.draft.create({ replyTo: mail.id, text: vorlage(mail) });"];
const added = [
  "    await logistik.task.create({ title: `Rückruf: ${mail.from.name}`, idempotencyKey: mail.id });",
  '    await owner.conversation.tag({ id: mail.conversationId, tag: "Rückruf" });',
];
const tail = [
  "  }",
  "});",
  "",
  'app.event("spaces.task.due", { space: "sp_ankauf" }, async (aufgabe) => {',
  "  // Offene Rückrufe gehen an die Buchhaltung.",
  '  await fetch("https://api.buchhaltung-beispiel.de/v1/rueckrufe", { method: "POST", body: aufgabe.id });',
  "});",
];
export const SOURCE_TAB_CODE = [...head, ...added, ...tail];
const PAGE = [
  'import { Page, Table } from "@sdk/ui";',
  "",
  'export default app.page("/rueckrufe", async () => {',
  '  const offen = await logistik.task.list({ status: "open" });',
  '  return <Page title="Offene Rückrufe"><Table rows={offen} /></Page>;',
  "});",
];
const same = (text: string): CodeDiffLine => ({ kind: "same", text });
/** Core's rows for version 3 against 4: the changed file as all old rows, then all new rows. */
export const SOURCE_TAB_CORE_ROWS = [
  {
    path: "code.ts",
    lines: [
      ...[...head, ...removed, ...tail].map((text): CodeDiffLine => ({ kind: "del", text })),
      ...SOURCE_TAB_CODE.map((text): CodeDiffLine => ({ kind: "add", text })),
    ],
  },
  { path: "seite.tsx", lines: PAGE.map(same) },
];

export type SourceTabFixtureState = "code" | "diff" | "one-version" | "none" | "error" | "long-file" | "long-line";

/** One state of the tab; the long line is 600 characters. `auswahl offen`, `lädt` and the phone are the `code` state opened, waiting or narrow. */
export function sourceTabFixture(state: SourceTabFixtureState): CodeSourceTabInitial {
  if (state === "none") return { state: "none" };
  if (state === "error") return { state: "error" };
  const base = { state: "ready" as const, enabled: SOURCE_TAB_ENABLED, versions: SOURCE_TAB_VERSIONS, file: "code.ts", compare: null };
  if (state === "diff") {
    const files = compareRows(SOURCE_TAB_CORE_ROWS);
    return { ...base, compare: VERSION_3.versionId, lines: null, diff: { kind: "rows", files, added: 2, removed: 1 } };
  }
  if (state === "one-version") {
    const lines = [
      'import { app, owner } from "@sdk";',
      "",
      'app.event("mail.message.received", { mailbox: "self" }, async (mail) => {',
      "  if (!/lieferzeit/i.test(mail.subject)) return;",
      '  await owner.conversation.assign({ id: mail.conversationId, team: "Logistik" });',
      "});",
    ];
    return { ...base, enabled: { id: VERSION_1.versionId, number: 1, files: ["code.ts"] }, versions: [], lines, diff: null };
  }
  if (state === "long-file") {
    const lines = Array.from({ length: 2_000 }, (_, index) => `  await logistik.task.create({ title: "Rückruf ${index + 1}" });`);
    return { ...base, lines, diff: null };
  }
  if (state === "long-line") {
    const long = `  const hinweis = "${"Rückruf bitte bis Freitag bestätigen. ".repeat(16).slice(0, 579)}";`;
    return { ...base, lines: [...SOURCE_TAB_CODE.slice(0, 6), long, ...SOURCE_TAB_CODE.slice(6)], diff: null };
  }
  return { ...base, lines: SOURCE_TAB_CODE, diff: null };
}
