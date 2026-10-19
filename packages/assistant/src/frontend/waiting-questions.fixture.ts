import type { AiConversation, AiOpenQuestion, AiOpenQuestions, AiTurnBlock, AiTurnSnapshot } from "@k2b/cloud/ai";
import { aiOpenQuestionFixture, aiQuestionFixtures } from "@k2b/cloud/ai/testing";

/**
 * "Waiting for you" for tests: the card mockup's multi scenario in German, with questions presented by the server's own
 * read from the chat's tool blocks. Fixed times, so nothing depends on the day a test runs.
 */

export const WAITING_NOW = "2026-10-17T12:10:00.000Z";
const at = (minutesAgo: number) => new Date(Date.parse(WAITING_NOW) - minutesAgo * 60_000).toISOString();
type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
type Key = "mail" | "del" | "routine";

const chat = (id: string, title: string, minutesAgo: number, waiting: boolean): AiConversation => ({
  id,
  shortId: id,
  title,
  titleSource: "user",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: at(minutesAgo),
  archivedAt: null,
  runStatus: waiting ? "needs_attention" : "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "user01",
  createdAt: at(600),
  updatedAt: at(minutesAgo),
});

const titles = { Wart42: "Wartung Oktober", Tops42: "Team Ops Wochenplanung" } as const;
const blocks = () => {
  const fixtures = aiQuestionFixtures("de");
  return { mail: fixtures.mail!.block, del: fixtures.del!.block, routine: fixtures.routine!.block } satisfies Record<Key, ToolBlock>;
};

/** A question as the server's read presents it from its tool block. */
export const waitingQuestion = (key: Key, conversationId: keyof typeof titles, minutesAgo: number): AiOpenQuestion => {
  const block = blocks()[key];
  return aiOpenQuestionFixture(
    { id: `req-${key}`, conversationId, conversationTitle: titles[conversationId], createdAt: at(minutesAgo), block },
    { locale: "de", timeZone: "Europe/Berlin" },
  );
};

const turn = (open: Key[]): AiTurnSnapshot => ({
  turnId: "turn-wartung",
  attempt: 1,
  seq: 20,
  status: open.length ? "waiting_for_action" : "completed",
  blocks: [{ id: "intro", kind: "text", text: "Zwei Dinge brauchen dein Ja:" }, ...open.map((key) => blocks()[key])],
  modelProfileId: "standard",
  createdAt: at(5),
});

const questions = (items: AiOpenQuestion[]): AiOpenQuestions => ({
  items: [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  count: items.length,
});

/** What a test reads from the waiting row's markup, on the server and in the browser alike. */
export type WaitingStripSummary = { quiet: boolean; label: string; entries: string[] };

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
/** Markup text as a person reads it: entities decoded in one pass, white space collapsed. */
const text = (raw: string) =>
  raw
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => entities[name] ?? "")
    .replace(/\s+/g, " ")
    .trim();

/** The waiting row in `html`, or `null` without one. Hydration markers and comments do not count. */
export const waitingStripSummary = (html: string): WaitingStripSummary | null => {
  let found = false;
  let quiet = false;
  let label = "";
  const entries: string[] = [];
  new HTMLRewriter()
    .on("nav.assistant-waiting", {
      element(nav) {
        if (found) return;
        found = true;
        quiet = nav.hasAttribute("data-quiet");
      },
    })
    .on("nav.assistant-waiting .assistant-waiting__label", {
      text(chunk) {
        label += chunk.text;
      },
    })
    .on("nav.assistant-waiting .assistant-waiting__entry", {
      element() {
        entries.push("");
      },
      text(chunk) {
        entries[entries.length - 1] += chunk.text;
      },
    })
    .transform(html);
  return found ? { quiet, label: text(label), entries: entries.map(text) } : null;
};

const mail = waitingQuestion("mail", "Wart42", 4);
const del = waitingQuestion("del", "Wart42", 3);
const routine = waitingQuestion("routine", "Tops42", 40);
const inOther = (question: AiOpenQuestion) => `${question.short} in ${titles.Tops42}`;

export const waitingFixture = {
  conversations: [chat("Wart42", titles.Wart42, 2, true), chat("Tops42", titles.Tops42, 40, true)],
  questions: questions([mail, del, routine]),
  /** The open chat is always Wartung Oktober. `server` is what its first frame shows. */
  cases: {
    three: {
      questions: questions([mail, del, routine]),
      activeTurn: turn(["mail", "del"]),
      server: { quiet: false, label: "Wartet auf dich", entries: [mail.short, del.short, inOther(routine)] },
    },
    two: {
      questions: questions([del, routine]),
      activeTurn: turn(["del"]),
      server: { quiet: false, label: "Wartet auf dich", entries: [del.short, inOther(routine)] },
    },
    // A chat opens at its end, where its only question's answers are: the row keeps its place, hidden.
    oneHere: {
      questions: questions([mail]),
      activeTurn: turn(["mail"]),
      server: { quiet: true, label: "Wartet auf dich", entries: [mail.short] },
    },
    oneElsewhere: {
      questions: questions([routine]),
      activeTurn: turn([]),
      server: { quiet: false, label: "Wartet auf dich", entries: [inOther(routine)] },
    },
    none: { questions: questions([]), activeTurn: turn([]), server: null },
  } satisfies Record<string, { questions: AiOpenQuestions; activeTurn: AiTurnSnapshot; server: WaitingStripSummary | null }>,
};
