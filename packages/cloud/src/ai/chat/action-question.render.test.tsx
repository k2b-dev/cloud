import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { capabilityActionReviewIssues } from "../../_internal/capability-reviews";
import { CapabilityActionCallReviewSchema } from "../../contracts/capabilities";
import type { AiTurnBlock } from "../protocol";
import type { ActionFixtureLocale } from "./action-question.fixtures";

const root = mkdtempSync(resolve(tmpdir(), "cloud-action-question-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { AiReaderTimeZoneProvider } = await import("./action-sentences");
const { AiChatActionsProvider } = await import("./message-actions");
const { AiTurnView } = await import("./turn-view");
const { layoutAiTurn } = await import("./turn-layout");
const { createAiToolDisclosureState } = await import("./tool-disclosure");
const { actionFixtures, actionFixtureReceipts, FIXTURE_AT } = await import("./action-question.fixtures");
const { LocaleProvider } = await import("@k2b/ui");

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

/** One turn with its text and one call, rendered on the server as the chat renders history and the live turn. */
const renderTurn = (
  block: ToolBlock,
  locale: ActionFixtureLocale,
  phase: "waiting" | "completed" | "running" = "waiting",
  actions: Record<string, unknown> = { onApproval: async () => undefined, onContinueTurn: () => undefined },
) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AiReaderTimeZoneProvider, {
          value: "Europe/Berlin",
          get children() {
            return createComponent(AiChatActionsProvider, {
              actions,
              get children() {
                return createComponent(AiTurnView, {
                  segment: () => ({
                    id: "turn",
                    turnId: "turn",
                    phase,
                    layout: layoutAiTurn([block], { phase }),
                    earlier: false,
                    duration: () => null,
                  }),
                  disclosureState: createAiToolDisclosureState(),
                });
              },
            });
          },
        });
      },
    }),
  );

/** Visible text without tags, so assertions read like the card. */
const text = (html: string) =>
  html
    .replace(/<!--[^>]*-->/g, "")
    // A person chip's initials are decoration; screen readers and people read the name.
    .replace(/<span class="k2b-reference__avatar" aria-hidden="true">.*?<\/span><\/span>/g, "")
    .replace(/<\/(dt|p|li|div|button|a|b)>/g, "</$1> ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");

const decided = (block: ToolBlock, patch: Partial<ToolBlock>): ToolBlock => ({
  ...block,
  approval: undefined,
  approved: true,
  at: FIXTURE_AT,
  ...patch,
});

describe("Action question fixtures", () => {
  test("every demo review is a valid review the app could send", () => {
    for (const locale of ["de", "en"] as const)
      for (const [key, fixture] of Object.entries(actionFixtures(locale))) {
        const review = fixture.block.review;
        if (!review || !("sentence" in review)) continue;
        expect({ key, locale, ok: CapabilityActionCallReviewSchema.safeParse(review).success }).toEqual({ key, locale, ok: true });
        // The check Query lives in the app; every other rule of the review applies here.
        const { check: _check, ...rest } = review;
        const issues = capabilityActionReviewIssues(rest, {
          locales: ["de", "en"],
          policy: { ask: review.ask ?? "app_asks" },
          queries: [],
          validateQueryInput: () => true,
        });
        expect({ key, issues }).toEqual({ key, issues: [] });
      }
  });
});

describe("card v4 question", () => {
  test("a question is one sentence with typed chips, Cloud's reason, the thing, and two answers that name deed and target", () => {
    const de = text(renderTurn(actionFixtures("de").mail!.block, "de")).replace(/\s+([.,?])/g, "$1");
    expect(de).toContain("Mail Wartungsfenster Dienstag an Lea Berg senden?");
    expect(de).toContain("Ich frage, weil das Cloud verlässt.");
    expect(de).toContain("Von Valentin Kolb valentin.kolb@k2b.dev");
    expect(de).toContain("An Lea Berg lea.berg@example.com");
    expect(de).toContain("Kein Cc oder Bcc. Wird sofort gesendet.");
    expect(de).toContain("Wartungsplan-KW43.pdf");
    expect(de).toContain("Ganze Mail lesen");
    expect(de).toContain("An Lea Berg senden");
    expect(de).toContain("Nicht senden");
    const html = renderTurn(actionFixtures("de").mail!.block, "de");
    // The card is a group named by its sentence and described by its reason; the thing chip links to the draft.
    expect(html).toMatch(/<section class="k2b-chat-decision__card" aria-labelledby="[^"]+-sentence" aria-describedby="[^"]+-reason"/);
    expect(html).toContain('href="/open/mail.draft/~dr-42"');
    expect(html).toContain('href="/app/mail/drafts/dr-42?revision=7"');
    // There is no avatar or icon column and no old card left.
    expect(html).not.toContain("ai-approval");
    expect(html).not.toContain("k2b-split-button");

    const en = text(renderTurn(actionFixtures("en").mail!.block, "en")).replace(/\s+([.,?])/g, "$1");
    expect(en).toContain("Send the email Maintenance window Tuesday to Lea Berg?");
    expect(en).toContain("I'm asking because this leaves Cloud.");
    expect(en).toContain("From Valentin Kolb valentin.kolb@k2b.dev");
    expect(en).toContain("No Cc or Bcc. Sends right away.");
    expect(en).toContain("Read the whole email");
    expect(en).toContain("Send to Lea Berg");
    expect(en).toContain("Don't send");
  });

  test("renders all seven preview kinds in German and English", () => {
    const expectations: Record<string, Record<ActionFixtureLocale, string[]>> = {
      // message, with Cc, Bcc, the send time, and Mail's own warning
      sched: {
        de: [
          "Cc Mira Hoffmann mira.hoffmann@k2b.dev",
          "Bcc Tom Weber tom.weber@k2b.dev",
          "Wird am 20. Okt. 2026, 08:00 gesendet.",
          "1 externer Empfänger.",
        ],
        en: ["Cc Mira Hoffmann", "Bcc Tom Weber", "Sends on", "1 external recipient."],
      },
      // event
      del: {
        de: [
          "Termin Retro am 17. Okt. 2026 löschen?",
          "15:00 – 16:00, Raum 2.14, im Kalender von Team Ops",
          "Lea Berg, Tom Weber, Mira Hoffmann und 3 weitere",
          "Retro löschen",
          "Behalten",
        ],
        en: [
          "Delete the event Retro on",
          "Room 2.14, in the Team Ops calendar",
          "Lea Berg, Tom Weber, Mira Hoffmann, and 3 more",
          "Delete Retro",
          "Keep it",
        ],
      },
      // task
      task: {
        de: ["Backups testen Team Ops", "Fällig am 21. Okt. 2026", "Restore auf Staging", "ops, backup", "Lea zuweisen"],
        en: ["Test backups Team Ops", "Due Oct 21, 2026", "Restore on staging", "Assign to Lea"],
      },
      // page, with a marked new paragraph
      note: {
        de: ["Woche 42 Abschnitt „Aufgaben“", "neu: Aufgaben dazu in Team Ops", "Ganz lesen", "Ja, und in diesem Chat nicht mehr fragen"],
        en: ["Week 42 section “Tasks”", "new: Tasks in Team Ops", "Read it all", "Yes, and don't ask again in this chat"],
      },
      // file, with access as consequence lines
      share: {
        de: [
          "Rechnungen 2026 48 Dateien in 3 Ordnern",
          "neu: Tom kann alles darin ansehen",
          "Ich frage, weil sich ändert, wer das sehen kann.",
        ],
        en: ["Invoices 2026 48 files in 3 folders", "new: Tom can view, change", "I'm asking because this changes who can see it."],
      },
      // rule, with a marked right and Cloud's line that a routine does not know the chat
      right: {
        de: [
          "Immer wenn in Team Ops oder Marketing eine neue Aufgabe entsteht",
          "neu: Liest neue Aufgaben in Marketing.",
          "Kennt diesen Chat nicht.",
          "Marketing dazunehmen",
        ],
        en: [
          "Whenever a new task is added in Team Ops or Marketing",
          "new: Reads new tasks in Marketing.",
          "Doesn't know this chat.",
          "Add Marketing",
        ],
      },
      // fields, with the old value struck through
      fields: {
        de: [
          "IBAN weg: DE02 1203 0000 0000 2020 51 neu: DE89 3704 0044 0532 0130 00",
          "Geändert am 17. Okt. 2026",
          "Zahlungen, Rechnungen, Adressen",
        ],
        en: ["IBAN removed: DE02 1203 0000 0000 2020 51 new: DE89 3704 0044 0532 0130 00", "Changed on Oct 17, 2026", "payments, invoices"],
      },
    };
    for (const [key, byLocale] of Object.entries(expectations))
      for (const locale of ["de", "en"] as const) {
        const rendered = text(renderTurn(actionFixtures(locale)[key]!.block, locale)).replace(/\s+([.,?])/g, "$1");
        for (const expected of byLocale[locale])
          expect({ key, locale, has: rendered.includes(expected) }).toEqual({ key, locale, has: true });
      }
  });

  test("an all-day event names its day only, without an end time", () => {
    const block = actionFixtures("en").del!.block;
    const review = block.review;
    if (!review || !("sentence" in review) || review.preview?.kind !== "event") throw new Error("event fixture missing");
    const allDay = {
      ...block,
      review: {
        ...review,
        preview: { ...review.preview, allDay: true, start: "2026-10-17T08:00:00.000Z", end: "2026-10-17T20:00:00.000Z" },
      },
    };
    const visible = text(renderTurn(allDay, "en"));
    expect(visible).toContain("Oct 17, 2026 · all day");
    expect(visible).not.toMatch(/– \d{1,2}:\d{2}/);
  });

  test("a delete asks with the danger answer; a Skill keeps its instruction and changes", () => {
    const del = renderTurn(actionFixtures("de").del!.block, "de");
    expect(del).toContain('data-variant="danger"');
    expect(del).toMatch(/k2b-chat-decision__reason" data-tone="danger"/);
    const skill = text(renderTurn(actionFixtures("de").skill!.block, "de"));
    expect(skill).toContain("Wenn du nach einem Wochenbericht fragst");
    expect(skill).toContain("Drei Abschnitte: Erledigt, Hängt, Nächste Woche.");
    expect(skill).toContain("Ganze Anleitung lesen");
    expect(renderTurn(actionFixtures("de").skill!.block, "de")).toContain('aria-label="Was sich ändert"');
    expect(skill).not.toContain("Kennt diesen Chat nicht");
  });

  test("never offers Always approve, and offers the chat link only where remembering for the chat exists", () => {
    for (const locale of ["de", "en"] as const)
      for (const fixture of Object.values(actionFixtures(locale))) {
        const html = renderTurn(
          { ...fixture.block, approval: fixture.block.approval && { ...fixture.block.approval, allowAlways: true } },
          locale,
        );
        expect(html).not.toMatch(/Always approve|Immer freigeben/);
        expect(html.includes("k2b-chat-decision__remember")).toBe(Boolean(fixture.block.approval?.allowChat));
      }
    const website = text(renderTurn(actionFixtures("de").website!.block, "de"));
    expect(website).toContain("Code ausführen?");
    expect(website).toContain("HTTP request GET https://query1.finance.yahoo.com/v7/finance/quote?symbols=NVDA");
    expect(website).toContain("Ja, und diese Website in diesem Chat erlauben");
  });

  test("the reason line is Cloud's words for the code, never the model's own reason", () => {
    const block = actionFixtures("de").mail!.block;
    const html = text(
      renderTurn(
        {
          ...block,
          args: { draftId: "dr-42", approvalReason: "Weil ich es so will." },
          presentation: { ...block.presentation!, approvalReason: true },
        },
        "de",
      ),
    );
    expect(html).toContain("Ich frage, weil das Cloud verlässt.");
    expect(html).not.toContain("Weil ich es so will.");
  });
});

describe("an answer that is not possible here", () => {
  test("turns confirm and the chat link off and says why in the reason's place; declining stays possible", () => {
    const html = renderTurn(actionFixtures("de").note!.block, "de", "waiting", {});
    expect(text(html)).toContain("Diese Frage kannst du hier nicht beantworten.");
    expect(text(html)).not.toContain("Ich frage, weil Notebooks hier jedes Mal fragt.");
    expect(html).toMatch(/<button[^>]*k2b-chat-decision__answer[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*k2b-chat-decision__remember[^>]*disabled/);
    const stopping = renderTurn(actionFixtures("de").note!.block, "de", "waiting", {
      onApproval: async () => undefined,
      actionDisabled: () => true,
    });
    expect(text(stopping)).toContain("Die Antwort wird angehalten.");
  });
});

describe("older reviews", () => {
  test("an old review renders as literal text: a long message with braces, 20 details, a date, and Markdown", () => {
    for (const locale of ["de", "en"] as const) {
      const block = actionFixtures(locale).legacy!.block;
      const html = renderTurn(block, locale);
      const visible = text(html);
      const message = block.approval!.review!;
      if (!("message" in message)) throw new Error("legacy fixture lost its old review");
      expect(message.message.length).toBe(1000);
      // The message is the question as it is, braces included; nothing reads it as a template.
      expect(visible).toContain(message.message.trim().replace(/\s+/g, " "));
      for (let index = 1; index <= 18; index += 1) expect(visible).toContain(`{value ${index}}`);
      expect(html).toContain('<time datetime="2026-10-20T06:00:00.000Z">');
      expect(html).toMatch(/<h2[^>]*>(Hallo|Hi) Lea<\/h2>/);
      expect(html).toContain("<strong>");
      // Each Markdown detail keeps its label above its own text.
      expect(html).toContain("<strong>Text</strong>");
      expect(visible).toContain(
        locale === "de" ? "Ich frage, weil Mail hier jedes Mal fragt." : "I'm asking because Mail always asks for this.",
      );
      expect(visible).toContain(locale === "de" ? "Entwurf senden" : "Send draft");
      expect(visible).toContain(locale === "de" ? "Nicht ausführen" : "Don't run");
    }
  });

  test("a stored legacy review wins over the live approval, so a reload reads the same", () => {
    const block = actionFixtures("en").legacy!.block;
    const stored: ToolBlock = {
      ...block,
      review: { legacy: { question: "Stored question {kept}", rows: [{ label: "To", value: "lea@example.com" }] } },
    };
    const visible = text(renderTurn(stored, "en"));
    expect(visible).toContain("Stored question {kept}");
    expect(visible).toContain("To lea@example.com");
    expect(visible).not.toContain("Sends the draft");
  });

  test("a call without any review asks Cloud's sentence and offers its input on demand", () => {
    const visible = renderTurn(
      {
        id: "tool-c",
        kind: "tool",
        callId: "c",
        name: "contacts__action__contact_dot_create",
        args: { name: "Ada" },
        status: "awaiting_approval",
        approval: { message: "Contacts: Create contact", allowAlways: false },
        presentation: {
          kind: "capability",
          appId: "contacts",
          appName: "Contacts",
          appIcon: "ti ti-address-book",
          title: "Create contact",
          capabilityKind: "action",
        },
      },
      "en",
    );
    expect(text(visible)).toContain("Create contact?");
    expect(text(visible)).toContain("Show input");
    expect(text(visible)).toContain("I'm asking because Contacts always asks for this.");
  });
});

describe("card v4 outcome line", () => {
  const de = actionFixtures("de");
  const outcome = (block: ToolBlock, phase: "completed" | "running" = "completed") => {
    const html = renderTurn(block, "de", phase);
    const start = html.indexOf('data-current="true"');
    const current = start < 0 ? html : html.slice(start, html.indexOf('role="status"', start));
    return { html, currentHtml: current, current: text(current).replace(/\s+([.,?])/g, "$1"), all: text(html) };
  };

  test("running and done share one cell, and done claims only what the app said", () => {
    const running = outcome(decided(de.mail!.block, { status: "running", at: undefined }), "running");
    expect(running.current).toContain("Mail Wartungsfenster Dienstag an Lea Berg wird gesendet …");
    expect(running.html).toContain('aria-busy="true"');
    // The done line already waits hidden in the same cell, so it reserves its height.
    expect(running.all).toContain("Mail Wartungsfenster Dienstag an Lea Berg wird gesendet.");
    const done = outcome(decided(de.mail!.block, { status: "completed", result: { data: {} } }));
    expect(done.current).toContain("wird gesendet.");
    expect(done.current).toContain("14:02");
  });

  test("a delete receipt strikes its chip and drops the link", () => {
    const done = outcome(decided(de.del!.block, { status: "completed", result: { data: {}, receipt: actionFixtureReceipts("de").del } }));
    expect(done.current).toContain("Termin Retro am 17. Okt. 2026 gelöscht.");
    expect(done.html).toMatch(/data-gone="true"/);
    expect(done.currentHtml).not.toContain('href="/open/spaces.event/~ev-17"');
  });

  test("declined, expired, stopped, and an error that proves nothing happened", () => {
    const declined = outcome(decided(de.mail!.block, { approved: undefined, status: "rejected", isError: true, result: "Rejected" }));
    expect(declined.current).toContain("Mail Wartungsfenster Dienstag an Lea Berg nicht gesendet. Du hast abgelehnt.");
    const expired = outcome(decided(de.mail!.block, { at: undefined, approved: false, status: "running" }));
    expect(expired.current).toContain("Die Frage ist abgelaufen.");
    expect(expired.current).toContain("Noch einmal fragen");
    expect(expired.html).toContain("ti-clock-x");
    const failed = outcome(
      decided(de.mail!.block, { status: "failed", isError: true, result: "BAD_INPUT: Der Mailserver kennt lea.berg@exmaple.com nicht." }),
    );
    expect(failed.current).toContain("nicht gesendet. Der Mailserver kennt lea.berg@exmaple.com nicht.");
    expect(failed.current).not.toContain("BAD_INPUT");
    expect(failed.html).toContain('data-tone="error"');
  });

  test("an unknown outcome says so, the check settles it, and nothing offers to run it again", () => {
    const unknown = "ACTION_OUTCOME_UNKNOWN: lost";
    const checking = outcome(decided(de.mail!.block, { status: "running", at: undefined, check: { state: "checking" } }), "running");
    expect(checking.current).toContain("weiß ich noch nicht. Die Verbindung brach ab. Ich frage Mail nach dem Stand …");
    const found = outcome(
      decided(de.mail!.block, { status: "completed", result: { data: null }, check: { state: "done", at: FIXTURE_AT } }),
    );
    expect(found.current).toContain("wird gesendet. Mail hat es schon erledigt. Ich führe es nicht noch einmal aus.");
    const notFound = outcome(
      decided(de.mail!.block, { status: "failed", isError: true, result: "ACTION_NOT_DONE: no", check: { state: "not_done" } }),
    );
    expect(notFound.current).toContain("nicht gesendet. Mail hat es nicht ausgeführt.");
    const pending = outcome(decided(de.mail!.block, { status: "failed", isError: true, result: unknown, check: { state: "pending" } }));
    expect(pending.current).toContain("Ob Mail Wartungsfenster Dienstag an Lea Berg senden passiert ist, weiß ich noch nicht.");
    expect(pending.current).toContain("In Mail öffnen");
    const failed = outcome(decided(de.mail!.block, { status: "failed", isError: true, result: unknown, check: { state: "failed" } }));
    expect(failed.current).toContain("weiß ich weiterhin nicht. Mail antwortet gerade nicht.");
    const review = de.mail!.block.review!;
    const noCheck = outcome(
      decided(de.mail!.block, {
        review: "sentence" in review ? { ...review, check: undefined } : review,
        status: "failed",
        isError: true,
        result: unknown,
      }),
    );
    expect(noCheck.current).toContain("Erneut ausführen geht erst, wenn klar ist, was passiert ist.");
    expect(noCheck.current).toContain("In Mail öffnen");
    expect(noCheck.all).not.toContain("Noch einmal prüfen");
    for (const line of [checking, found, notFound, pending, failed, noCheck])
      expect(line.all).not.toMatch(/Erneut senden|Noch einmal senden|An Lea Berg senden/);
  });

  test("an old review's done line is the app's old summary", () => {
    const block = actionFixtures("en").legacy!.block;
    const done = outcome(decided(block, { status: "completed", result: { data: {}, summary: "Draft queued for sending." } }));
    expect(done.current).toContain("Draft queued for sending.");
  });
});
