import { expect, test } from "bun:test";
import { type CapabilityActionCallReview, CapabilityActionCallReviewSchema } from "../contracts/capabilities";
import { reviewShortText, toolActionCard, toolBlockReview } from "./chat/action-card";
import { FIXTURE_AT, actionFixtures } from "./chat/action-question.fixtures";
import { legacyOutcomeWords } from "./chat/tool-action-words";
import { listAiOpenQuestions, openQuestionFromRow } from "./open-questions";
import type { AiTurnBlock } from "./protocol";

test("the server read and shared card wording load without a browser runtime", () => {
  expect(typeof document).toBe("undefined");
  expect(typeof listAiOpenQuestions).toBe("function");
  const block: Extract<AiTurnBlock, { kind: "tool" }> = {
    id: "tool-send",
    kind: "tool",
    callId: "send",
    name: "mail.draft.send",
    status: "awaiting_approval",
    review: { legacy: { question: "Send this letter?", rows: [] } },
  };
  const card = toolActionCard(block, { locale: "en", timeZone: "UTC", outcome: legacyOutcomeWords(block, "en", "UTC") });
  expect(card.questionText).toBe("Send this letter?");
  expect(card.app.name).toBe("Cloud");
});

const context = { locale: "en", timeZone: "UTC" };
type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

const row = (block: ToolBlock | null): Parameters<typeof openQuestionFromRow>[0] => ({
  id: "approval-1",
  conversationId: "chat-1",
  conversationTitle: "A letter",
  displayCallId: block?.callId ?? "missing",
  appId: "mail",
  sentence: "Send this draft\nFull request details",
  toolName: "mail.draft.send",
  createdAt: new Date(FIXTURE_AT),
  block,
});

const reviewOf = (block: ToolBlock): CapabilityActionCallReview => {
  const review = toolBlockReview(block);
  if (!review || "legacy" in review) throw new Error("Expected a modern fixture review");
  return review;
};

const cases = [
  ["de", "mail", "Mail an Lea Berg senden"],
  ["de", "del", "Termin Retro am 17. Okt. 2026 löschen"],
  ["de", "task", "Aufgabe Backups testen in Team Ops anlegen und Lea Berg zuweisen"],
  ["de", "routine", "Routine Neue Aufgaben zusammenfassen anlegen"],
  ["en", "mail", "Send email to Lea Berg"],
  ["en", "del", "Delete the event Retro on Oct 17, 2026"],
  ["en", "task", "Create the task Test backups in Team Ops and assign it to Lea Berg"],
  ["en", "routine", "Create the routine Summarize new tasks"],
] as const;

for (const [locale, key, expected] of cases) {
  test(`${locale} ${key}: short text reads the card's chips`, () => {
    const block = actionFixtures(locale)[key]!.block;
    const review = reviewOf(block);
    const card = toolActionCard(block, { ...context, outcome: legacyOutcomeWords(block, context.locale, context.timeZone) });
    const short = reviewShortText(review, { ...context, app: card.app });
    expect(short).toBe(expected);
    expect(short).not.toMatch(/[<@]/);
    expect(openQuestionFromRow(row(block), context).short).toBe(expected);
  });
}

for (const [locale, expected] of [
  ["de", "Mail Wartungsfenster Dienstag an Lea Berg senden"],
  ["en", "Send the email Maintenance window Tuesday to Lea Berg"],
] as const) {
  test(`${locale} mail without a short template falls back to the action's chips`, () => {
    const block = actionFixtures(locale).mail!.block;
    const review = reviewOf(block);
    const { short: _short, ...sentence } = review.sentence;
    const withoutShort = { ...review, sentence };
    const short = reviewShortText(withoutShort, { ...context, app: { name: "Mail", icon: "ti ti-mail" } });
    expect(short).toBe(expected);
    expect(openQuestionFromRow(row({ ...block, review: withoutShort }), context).short).toBe(expected);
    expect(short).not.toMatch(/[<@„“]/);
  });
}

test("an explicit short template renders person slots as names only", () => {
  const block = actionFixtures("de").task!.block;
  const review = reviewOf(block);
  const explicit = { ...review, sentence: { ...review.sentence, short: "An {person} zuweisen" } };
  expect(reviewShortText(explicit, { ...context, app: { name: "Spaces", icon: "ti ti-layout-kanban" } })).toBe("An Lea Berg zuweisen");
  expect(openQuestionFromRow(row({ ...block, review: explicit }), context).short).toBe("An Lea Berg zuweisen");
});

test("legacy reviews and calls without a review keep the card's question", () => {
  const block = actionFixtures("en").mail!.block;
  const legacy = { ...block, review: { legacy: { question: "Send the letter exactly as written?", rows: [] } } };
  expect(openQuestionFromRow(row(legacy), context).short).toBe("Send the letter exactly as written?");
  expect(openQuestionFromRow(row({ ...block, review: undefined, approval: undefined }), context).short).toBe("Send draft?");
});

test("bounds modern, legacy, and fallback short text to 160 code points, including the ellipsis", () => {
  const block = actionFixtures("en").mail!.block;
  const long = `${"x".repeat(158)}😀yz`;
  const expected = `${"x".repeat(158)}😀…`;
  const review = CapabilityActionCallReviewSchema.parse({
    locale: "en",
    sentence: { action: "{subject}", running: "{subject}", done: "{subject}", confirm: "Proceed", decline: "Cancel" },
    slots: { subject: { kind: "object", title: long } },
  });
  const blocks = [
    { ...block, review: CapabilityActionCallReviewSchema.parse({ ...review, sentence: { ...review.sentence, short: "{subject}" } }) },
    { ...block, review },
    { ...block, review: { legacy: { question: long, rows: [] } } },
    null,
  ];
  for (const value of blocks) {
    const question = openQuestionFromRow({ ...row(value), sentence: `${long}\nDetails` }, context);
    expect(question.short).toBe(expected);
    expect(Array.from(question.short)).toHaveLength(160);
    expect(question.short.isWellFormed()).toBe(true);
  }
});

test("short text at the limit stays literal, including a complete supplementary code point", () => {
  const short = `${"x".repeat(158)}😀z`;
  expect(openQuestionFromRow({ ...row(null), sentence: short }, context).short).toBe(short);
  expect(openQuestionFromRow({ ...row(null), sentence: "" }, context).short).toBe("");
});

test("bounds conversation titles to 200 code points on every presentation path", () => {
  const long = `${"t".repeat(198)}🧭yz`;
  const expected = `${"t".repeat(198)}🧭…`;
  const block = actionFixtures("en").mail!.block;
  for (const value of [block, { ...block, review: { legacy: { question: "Send?", rows: [] } } }, null]) {
    const question = openQuestionFromRow({ ...row(value), conversationTitle: long }, context);
    expect(question.conversationTitle).toBe(expected);
    expect(Array.from(question.conversationTitle!)).toHaveLength(200);
    expect(question.conversationTitle!.isWellFormed()).toBe(true);
  }
  const exact = `${"t".repeat(198)}🧭z`;
  expect(openQuestionFromRow({ ...row(null), conversationTitle: exact }, context).conversationTitle).toBe(exact);
  expect(openQuestionFromRow({ ...row(null), conversationTitle: null }, context).conversationTitle).toBeNull();
});
