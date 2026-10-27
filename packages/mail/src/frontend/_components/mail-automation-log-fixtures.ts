import type { AutomationLogDetail, AutomationLogItem, AutomationLogPage, AutomationLogTarget } from "./mail-automation-log-model";

/** Fictional Protokoll of the mailbox "Vertrieb" as the approved mockup shows it (26.10.). */
const day = "2026-10-26";
const at = (time: string) => `${day}T${time}:00.000Z`;
const sortRule = {
  kind: "rule" as const,
  workflowId: "Wf001",
  name: "Mails nach Art verteilen",
  position: 1,
  version: 3,
  ai: true,
  href: "/app/mail/Box001/automations/workflows",
};
const rule = (workflowId: string, name: string, position: number) => ({
  kind: "rule" as const,
  workflowId,
  name,
  position,
  version: 1,
  ai: false,
  href: "/app/mail/Box001/automations/workflows",
});
const group = (id: string, name: string): AutomationLogTarget => ({ kind: "group", id, name });
const user = (id: string, name: string): AutomationLogTarget => ({ kind: "user", id, name });
const conversation = (id: string, subject: string, name: string) => ({
  id,
  subject,
  from: { name, email: `${name.toLowerCase().replace(/[^a-z]+/gu, ".")}@example.test` },
  href: `/app/mail/Box001?conversation=${id}`,
});
const available = { state: "available" as const, reason: null, by: null, at: null };
const none = { state: "none" as const, reason: null, by: null, at: null };
const choices = ["Reklamation", "Anfrage", "Sonstiges", "Unsicher"];

export const logFixtureItems: AutomationLogItem[] = [
  {
    id: "Log001",
    at: at("09:02"),
    conversation: conversation("Conv01", "Reklamation Lieferung vom 14.10.", "Tomás Silva"),
    by: sortRule,
    outcome: "assigned",
    effects: [{ kind: "assign", target: group("Grp001", "Team Reklamation") }],
    reasons: [
      { kind: "ai_choice", value: "Reklamation", choices },
      { kind: "ai_value", field: "Betrag", value: "180 €", evidence: "Schaden von 180 €" },
      { kind: "comparison", text: "über 500 €", met: false },
    ],
    undo: available,
  },
  {
    id: "Log002",
    at: at("08:47"),
    conversation: conversation("Conv02", "Angebot Visitenkarten 2026", "Jana Berger"),
    by: sortRule,
    outcome: "assigned",
    effects: [{ kind: "assign", target: group("Grp002", "Team Angebote") }],
    reasons: [{ kind: "ai_choice", value: "Anfrage", choices }],
    undo: available,
  },
  {
    id: "Log003",
    at: at("08:47"),
    conversation: conversation("Conv02", "Angebot Visitenkarten 2026", "Jana Berger"),
    by: rule("Wf002", "Großkunden an Can", 2),
    outcome: "skipped",
    effects: [],
    reasons: [{ kind: "skipped_upper_rule", workflowId: "Wf001", name: "Mails nach Art verteilen" }],
    undo: none,
  },
  {
    id: "Log004",
    at: at("07:58"),
    conversation: conversation("Conv03", "Fehldruck Tüten – bitte an Herrn Seidel", "Kemal Aydın"),
    by: sortRule,
    outcome: "assigned",
    effects: [{ kind: "assign", target: user("Usr001", "Nora Albrecht") }],
    reasons: [
      { kind: "ai_choice", value: "Reklamation", choices },
      { kind: "ai_value", field: "Betrag", value: "860 €", evidence: "Rechnung über 860 €" },
      { kind: "comparison", text: "über 500 €", met: true },
    ],
    undo: available,
  },
  {
    id: "Log005",
    at: at("07:30"),
    conversation: conversation("Conv04", "Quote request: 500 tote bags", "Mira Okafor"),
    by: sortRule,
    outcome: "uncertain",
    effects: [{ kind: "assign", target: group("Grp003", "Eingang prüfen") }],
    reasons: [{ kind: "ai_choice", value: "Unsicher", choices }],
    undo: available,
  },
  {
    id: "Log006",
    at: at("07:05"),
    conversation: conversation("Conv05", "Rechnung R-2026-0412", "Papier Krause GmbH"),
    by: sortRule,
    outcome: "nobody",
    effects: [],
    reasons: [
      { kind: "ai_choice", value: "Sonstiges", choices },
      { kind: "no_target", choice: "Sonstiges" },
    ],
    undo: none,
  },
  {
    id: "Log007",
    at: at("07:05"),
    conversation: conversation("Conv05", "Rechnung R-2026-0412", "Papier Krause GmbH"),
    by: rule("Wf003", "Rechnungen ablegen", 3),
    outcome: "effects",
    effects: [
      { kind: "tag", name: "Rechnung" },
      { kind: "assign", target: group("Grp004", "Buchhaltung") },
      { kind: "move", folder: "Rechnungen" },
    ],
    reasons: [
      { kind: "condition", text: "Betreff enthält „Rechnung“" },
      { kind: "condition", text: "PDF angehängt." },
    ],
    undo: available,
  },
  {
    id: "Log008",
    at: at("06:40"),
    conversation: conversation("Conv06", "Druckfreigabe Plakate Herbstfest", "Stadtwerke Linden"),
    by: { kind: "person", userId: "Usr001", name: "Nora Albrecht" },
    outcome: "manual_change",
    effects: [{ kind: "assign", target: user("Usr002", "Lisa Brandt") }],
    reasons: [
      {
        kind: "manual",
        before: { kind: "group", name: "Team Angebote", byRule: "Mails nach Art verteilen" },
        after: { kind: "user", name: "Lisa Brandt" },
      },
    ],
    undo: none,
  },
];

export const logFixturePage = (items: AutomationLogItem[] = logFixtureItems): AutomationLogPage => ({
  day,
  counts: { all: 47, assignments: 21, uncertain: 3, skipped: 4, manual: 1 },
  items,
  nextCursor: items.length > 0 ? "older" : null,
});

export const logFixtureDetail = (item: AutomationLogItem = logFixtureItems[3]!): AutomationLogDetail => ({
  ...item,
  chain: [
    { kind: "rule_start", name: "Mails nach Art verteilen", version: 3, position: 1, preconditions: ["Niemand war zuständig."] },
    { kind: "ai_choice", value: "Reklamation", choices },
    { kind: "ai_value", field: "den Betrag", value: "860 €", evidence: "Rechnung über 860 €" },
    { kind: "fixed_row", text: "Reklamation und Betrag über 500 € → Nora Albrecht", target: { kind: "user", name: "Nora Albrecht" } },
    { kind: "result", effects: item.effects, unchanged: ["Status „Handlungsbedarf“ bleibt.", "Sonst nichts geändert."] },
  ],
  aiCalls: { run: 2, today: 46, limit: 300 },
});
