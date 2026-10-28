import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { ConversationContentSummary } from "../../service/conversation-summary";
import { summaryState } from "./mail-summary-fixtures";

const root = mkdtempSync(join(tmpdir(), "mail-summary-card-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailConversationSummaryCard, showsConversationSummary } = await import("./MailConversationSummaryCard.tsx");

const NOW = Date.parse("2026-10-26T08:50:00.000Z");
const rule = { kind: "workflow" as const, id: "Wf001", name: "Lange Mails zusammenfassen" };
const aiSummary = (overrides: Partial<ConversationContentSummary> = {}) =>
  summaryState({
    summary:
      "- Neues Angebot: 500 Visitenkarten auf 350 g Naturpapier für 214 € netto.\n- Lieferung am 6.11. nur mit Freigabe bis Mi., 29.10.",
    source: "workflow",
    author: rule,
    ai: true,
    generatedAt: "2026-10-26T08:47:00.000Z",
    coveredMessageCount: 5,
    nextStep: { text: "Freigabe bis Mi., 29.10.", due: "2026-10-29" },
    canGenerate: true,
    ...overrides,
  });

const render = (state: ConversationContentSummary, locale: "de" | "en" = "de", canEdit = true) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(MailConversationSummaryCard, {
          state,
          canEdit,
          onEdit: () => undefined,
          onGenerate: () => undefined,
          now: () => NOW,
        });
      },
    }),
  );

describe("MailConversationSummaryCard", () => {
  test("an AI summary sits on the AI surface with ✦, tools, its next step and where it came from", () => {
    const html = render(aiSummary());
    expect(html).toContain('data-mail-conversation-summary="text"');
    expect(html).toContain("data-mail-summary-ai");
    expect(html).toContain("bg-[var(--k2b-ai-surface)]");
    expect(html).toContain("ti-sparkles");
    expect(html).toContain("Kurz gesagt");
    expect(html).toContain('aria-label="Neu schreiben"');
    expect(html).toContain('aria-label="Zusammenfassung bearbeiten"');
    expect(html).toContain('aria-label="Wie diese Zusammenfassung entstand"');
    expect(html).toContain("<li>Neues Angebot: 500 Visitenkarten");
    expect(html).toContain("Nächster Schritt");
    expect(html).toContain("Freigabe bis Mi., 29.10.");
    expect(html).toContain("Aus 5 Nachrichten · Regel „Lange Mails zusammenfassen“ · vor 3 Min.");
    expect(html).toContain("min-h-[12.25rem]");
  });

  test("a text a person wrote stays neutral: no ✦, no cyan", () => {
    const html = render(
      summaryState({
        summary: "Zahlen abgestimmt, Rechnung nächste Woche.",
        source: "person",
        author: { kind: "user", id: "U1", name: "Lisa Brandt" },
        generatedAt: "2026-10-26T06:50:00.000Z",
      }),
    );
    expect(html).not.toContain("data-mail-summary-ai");
    expect(html).not.toContain("--k2b-ai");
    expect(html).not.toContain("ti-sparkles");
    expect(html).toContain("Von Lisa Brandt geschrieben · vor 2 Std.");
    expect(html).not.toContain('aria-label="Neu schreiben"');
  });

  test("new messages since this version offer to continue", () => {
    const html = render(aiSummary({ newMessagesSince: 1 }));
    expect(html).toContain("1 neue Nachricht seit dieser Fassung");
    expect(html).toContain(">Fortschreiben<");
    expect(render(aiSummary({ newMessagesSince: 3 }), "en")).toContain("3 new messages since this version");
  });

  test("while the AI writes, the area keeps its height and announces it", () => {
    const html = render(aiSummary({ summary: null, status: "writing" }));
    expect(html).toContain('data-mail-conversation-summary="writing"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("wird geschrieben …");
    expect(html).toContain("min-h-[12.25rem]");
    expect(html.match(/k2b-skeleton/g)?.length).toBe(5);
    expect(html).not.toContain('aria-label="Neu schreiben"');
  });

  test("a failure says what did not happen, what stays, and offers to try again", () => {
    const html = render(
      aiSummary({
        summary: null,
        status: "failed",
        failure: { code: "timeout", attempts: 3, lastAttemptAt: "2026-10-26T08:49:00.000Z", workflow: { id: "Wf001", name: rule.name } },
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain(
      "Die Zusammenfassung ist nicht entstanden: Die KI hat nicht rechtzeitig geantwortet. Die Unterhaltung ist unverändert.",
    );
    expect(html).toContain("Erneut versuchen");
    expect(html).toContain("Regel „Lange Mails zusammenfassen“ · 3 Versuche, zuletzt");
  });

  test("the daily limit explains itself and lets a person summarize this one on their own allowance", () => {
    const html = render(
      aiSummary({
        summary: null,
        status: "limited",
        limit: { scope: "rule", workflow: { id: "Wf001", name: rule.name }, limit: 200, resetsAt: "2026-10-26T23:00:00.000Z" },
        allowance: { unlimited: false, usedPercent: 24, resetsAt: null },
      }),
    );
    expect(html).toContain(
      "Heute keine automatischen Zusammenfassungen mehr: Das Tageslimit von 200 KI-Aufrufen für „Lange Mails zusammenfassen“ ist erreicht. Ab Mitternacht geht es weiter. Die Mail ist unverändert.",
    );
    expect(html).toContain("Diese eine jetzt zusammenfassen");
    expect(html).toContain("Zählt auf dein persönliches KI-Kontingent");
    expect(html).toContain("24 % genutzt");
    const mailbox = render(
      aiSummary({ summary: null, status: "limited", limit: { scope: "mailbox", workflow: null, limit: 500, resetsAt: "x" } }),
    );
    expect(mailbox).toContain("für dieses Postfach");
  });

  test("without permission to ask the AI, no AI buttons show", () => {
    const html = render(aiSummary({ canGenerate: false, newMessagesSince: 2 }), "de", false);
    expect(html).not.toContain('aria-label="Neu schreiben"');
    expect(html).not.toContain('aria-label="Zusammenfassung bearbeiten"');
    expect(html).not.toContain(">Fortschreiben<");
  });

  test("the reader shows the area for a text or for work in progress, not for nothing", () => {
    expect(showsConversationSummary(null)).toBe(false);
    expect(showsConversationSummary(summaryState())).toBe(false);
    expect(showsConversationSummary(summaryState({ status: "pending" }))).toBe(true);
    expect(showsConversationSummary(summaryState({ summary: "x" }))).toBe(true);
  });
});
