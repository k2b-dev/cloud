import { expect, test } from "bun:test";
import { type CapabilityActionCallReview, CapabilityActionCallReviewSchema } from "../contracts/capabilities";
import { AiOpenQuestionsCursorSchema } from "../contracts/open-questions";
import { reviewShortText, toolActionCard, toolBlockReview } from "./chat/action-card";
import { actionFixtures, FIXTURE_AT } from "./chat/action-question.fixtures";
import { legacyOutcomeWords } from "./chat/tool-action-words";
import {
  aiOpenQuestionsPage,
  compareAiOpenQuestions,
  countAiOpenQuestions,
  listAiOpenQuestions,
  openQuestionFromRow,
} from "./open-questions";
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

// Each fixture is read by a reader of its own language; a card follows the reader's locale.
const readerOf = (locale: "de" | "en") => ({ locale, timeZone: "UTC" });
const context = readerOf("en");
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
    const context = readerOf(locale);
    const block = actionFixtures(locale)[key]!.block;
    const review = reviewOf(block);
    const card = toolActionCard(block, { ...context, outcome: legacyOutcomeWords(block, context.locale, context.timeZone) });
    const short = reviewShortText(review, { ...context, app: card.app });
    expect(short).toBe(expected);
    expect(short).not.toMatch(/[<@]/);
    expect(openQuestionFromRow(row(block), context).short).toBe(expected);
  });
}

test("an app's German sentence keeps its words and shows its values in an English reader's formats", () => {
  const block = actionFixtures("de").del!.block;
  const short = reviewShortText(reviewOf(block), { ...readerOf("en"), app: { name: "Spaces", icon: "ti ti-calendar" } });
  expect(short).toBe("Termin Retro am Oct 17, 2026 löschen");
});

for (const [locale, expected] of [
  ["de", "Mail Wartungsfenster Dienstag an Lea Berg senden"],
  ["en", "Send the email Maintenance window Tuesday to Lea Berg"],
] as const) {
  test(`${locale} mail without a short template falls back to the action's chips`, () => {
    const context = readerOf(locale);
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

test("a separately deployed app reads the shared list and badge through Core with the person's credentials", async () => {
  const previousOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://questions.test";
  const requests: Request[] = [];
  const questions = {
    count: 2,
    items: [
      { ...openQuestionFromRow(row(null), context), kind: "approval" as const },
      {
        ...openQuestionFromRow(row(null), context),
        id: "version-2",
        kind: "code_activate" as const,
        href: "/app/assistant/code/c_test",
      },
    ],
  };
  const caller = {
    authorization: "Bearer waiting-fixture",
    requestId: "waiting-request",
    locale: "de",
    transport: async (request: Request) => {
      requests.push(request);
      return Response.json({ data: questions });
    },
  };
  try {
    const input = { ownerUserId: "11111111-1111-4111-8111-111111111111", locale: "de", timeZone: "Europe/Berlin", caller };
    expect(await listAiOpenQuestions(input)).toEqual(questions);
    expect(await countAiOpenQuestions(input.ownerUserId, { caller })).toBe(2);
    const cursor = { createdAt: questions.items[0]!.createdAt, id: questions.items[0]!.id };
    expect(await listAiOpenQuestions({ ...input, cursor })).toEqual(questions);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(new URL(request.url).pathname).toBe("/api/capabilities/v1/queries/core/ai.open_questions");
      expect(request.headers.get("authorization")).toBe("Bearer waiting-fixture");
      expect(request.headers.get("x-request-id")).toBe("waiting-request");
      expect(request.headers.get("x-cloud-locale")).toBe("de");
      expect(request.method).toBe("POST");
    }
    expect(await requests[0]!.json()).toEqual({ input: { timeZone: "Europe/Berlin" } });
    expect(await requests[2]!.json()).toEqual({ input: { timeZone: "Europe/Berlin", cursor } });
  } finally {
    if (previousOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
    else process.env.CLOUD_CORE_INTERNAL_ORIGIN = previousOrigin;
  }
});

test("a reader asking for one kind gets it even behind twenty older questions, with the feed's page size and no approval read", async () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 14, 6, minute)).toISOString();
  const older = Array.from({ length: 20 }, (_, index) => ({
    id: `code:older-${index}`,
    kind: "code_activate" as const,
    conversationId: "Chat42",
    conversationTitle: "Messe Köln",
    anchor: `code-${index}`,
    short: `Version ${index + 1} einschalten`,
    app: { name: "Code", icon: "ti ti-player-play" },
    createdAt: at(index),
  }));
  const automation = {
    id: "code-attention:c_brief1",
    kind: "code_attention" as const,
    conversationId: "",
    conversationTitle: null,
    anchor: "",
    short: "Morgenbriefing braucht einen Chat",
    app: { name: "Code", icon: "ti ti-code" },
    reason: "chat_missing" as const,
    href: "/app/assistant/code/c_brief1",
    createdAt: at(59),
  };
  const asked: (string | undefined)[] = [];
  // A source that ignores the kind still cannot hide it: the feed keeps only the asked kind before it cuts the page.
  const source = async (input: { kind?: string }) => {
    asked.push(input.kind);
    return { count: 21, items: [...older, automation] };
  };
  const all = await listAiOpenQuestions({ ownerUserId: "u1", ...context, kind: "code_activate", sources: [source] });
  expect(all.items).toHaveLength(20);
  expect(all.items.map((item) => item.id)).not.toContain(automation.id);
  const only = await listAiOpenQuestions({ ownerUserId: "u1", ...context, kind: "code_attention", sources: [source] });
  expect(only.items).toEqual([automation]);
  expect(asked).toEqual(["code_activate", "code_attention"]);
});

test("pages source questions with stable timestamp ties, total counts and a terminal page", async () => {
  const items = Array.from({ length: 43 }, (_, index) => ({
    ...openQuestionFromRow(row(null), context),
    id: `code:${String(index).padStart(3, "0")}`,
    kind: "code_activate" as const,
  }));
  const source: import("./open-questions").AiOpenQuestionSource = async (input) =>
    aiOpenQuestionsPage(
      items.filter((item) => !input.cursor || compareAiOpenQuestions(item, input.cursor) > 0),
      items.length,
    );
  const input = { ownerUserId: "u1", ...context, kind: "code_activate" as const, sources: [source] };
  const first = await listAiOpenQuestions(input);
  const second = await listAiOpenQuestions({ ...input, cursor: first.nextCursor });
  const third = await listAiOpenQuestions({ ...input, cursor: second.nextCursor });
  expect([first.items.length, second.items.length, third.items.length]).toEqual([20, 20, 3]);
  expect([first.count, second.count, third.count]).toEqual([43, 43, 43]);
  expect([...first.items, ...second.items, ...third.items]).toEqual(items);
  expect(first.nextCursor).toEqual({ createdAt: items[19]!.createdAt, id: items[19]!.id });
  expect(third.nextCursor).toBeUndefined();
  // Cursors describe a position, not a row that must still exist.
  items.splice(19, 1);
  expect((await listAiOpenQuestions({ ...input, cursor: first.nextCursor })).items).toEqual(second.items);
});

test("preserves source lookahead when exactly one full page is merged", async () => {
  const items = Array.from({ length: 21 }, (_, index) => ({
    ...openQuestionFromRow(row(null), context),
    id: `code:${String(index).padStart(3, "0")}`,
    kind: "code_activate" as const,
  }));
  const page = await listAiOpenQuestions({
    ownerUserId: "u1",
    ...context,
    kind: "code_activate",
    sources: [async () => aiOpenQuestionsPage(items, 21)],
  });
  expect(page.items).toHaveLength(20);
  expect(page.nextCursor?.id).toBe(items[19]!.id);
});

test("cursor IDs are bounded and timestamp ties follow PostgreSQL C code-point ordering", () => {
  const createdAt = new Date(FIXTURE_AT).toISOString();
  expect(AiOpenQuestionsCursorSchema.safeParse({ createdAt, id: "x".repeat(100) }).success).toBe(true);
  expect(AiOpenQuestionsCursorSchema.safeParse({ createdAt, id: "x".repeat(101) }).success).toBe(false);
  const ids = ["😀", "é", "a", "_", "Z", "-", "aa", "\uE000"];
  const sorted = ids
    .map((id) => ({ createdAt, id }))
    .sort(compareAiOpenQuestions)
    .map((item) => item.id);
  expect(sorted).toEqual(["-", "Z", "_", "a", "aa", "é", "\uE000", "😀"]);
  expect(compareAiOpenQuestions({ createdAt: "2026-10-01T00:00:00.000Z", id: "z" }, { createdAt, id: "a" })).toBeLessThan(0);
});

test("a secret waiting entry projects name and anchor, never tool arguments or results", async () => {
  const { secretOpenQuestion } = await import("./open-questions");
  const privateValue = "fixture-private-value";
  const raw = {
    id: "secret-1",
    call_id: "secret-call",
    name: "API",
    short_id: "Chat42",
    title: "Automation",
    created_at: new Date(FIXTURE_AT),
    args: { value: privateValue },
    result: { value: privateValue },
  };
  const projected = secretOpenQuestion(raw);
  expect(projected).toMatchObject({ kind: "secret", anchor: "tool-secret-call", short: "Secret API", conversationId: "Chat42" });
  expect(JSON.stringify(projected)).not.toContain(privateValue);
});
