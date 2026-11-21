import type { AiOpenQuestion, AiOpenQuestions, AiTurnBlock } from "@k2b/cloud/ai";

/**
 * Something in this chat that stopped and waits for the person, such as a routine that needs attention or an app whose
 * last run failed. It goes where the chat's details would take the person.
 */
export type WaitingAttention = { key: string; kind: "routine" | "app_run"; short: string; open: () => void };

/** What the "Waiting for you" strip shows above the composer. */
export type WaitingQuestionsView = {
  /** What stopped in this chat and waits for the person; it comes first. */
  attention: WaitingAttention[];
  /** Open questions of this chat first, in the order they were asked, then those of other chats. */
  entries: AiOpenQuestion[];
  /** Open questions the server's bounded read left out; the strip offers them through the Approvals view. */
  more: number;
  /** All open questions of the person. The strip keeps its place while this is above zero. */
  total: number;
  /**
   * The anchor of this chat's only waiting entry while this chat shows its card (v12 3m): the strip leaves that entry out
   * while its answers are in view, and is quiet when nothing else waits. Entries of other chats stay in the row.
   */
  onlyHere: string | null;
  /**
   * Whether that entry's card waits in the chat's active turn, at its end: the server and the first frame then leave it
   * out. Any other card, such as a version to switch on, leaves the row only once the chat shows its answers.
   */
  onlyHereAtEnd: boolean;
};

const byAsked = (a: AiOpenQuestion, b: AiOpenQuestion) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * The strip's questions: the server's read for every chat, corrected by what this chat already shows. A question the
 * person answered here leaves at once, and a question that just opened here keeps the strip's place from the frame
 * the card appears in, before the read catches up.
 *
 * `local` is the tool blocks of the open chat's active turn, or `null` while that chat is not loaded.
 */
export const waitingQuestionsView = (input: {
  questions: AiOpenQuestions;
  conversationId: string | null;
  local: readonly AiTurnBlock[] | null;
  /** What stopped in the open chat and waits for the person, from its details. */
  attention?: readonly WaitingAttention[];
}): WaitingQuestionsView => {
  const { questions, conversationId, local } = input;
  const attention = conversationId === null ? [] : [...(input.attention ?? [])];
  const here = (question: AiOpenQuestion) => conversationId !== null && question.conversationId === conversationId;
  const localTools = local ? local.filter((block) => block.kind === "tool") : null;
  const openHere = localTools
    ? localTools
        .filter((block) => block.status === "awaiting_approval" || (block.name === "code_secret" && block.status === "awaiting_client"))
        .map((block) => block.id)
    : null;
  const known = localTools ? new Set(localTools.map((block) => block.id)) : null;
  // A block this chat shows decides; one it does not show yet stays as the server read it.
  const stillOpen = (question: AiOpenQuestion) =>
    (question.kind !== "approval" && question.kind !== "secret") ||
    !here(question) ||
    !known?.has(question.anchor) ||
    Boolean(openHere?.includes(question.anchor));
  const entries = questions.items.filter(stillOpen);
  const listedHere = new Set(entries.filter(here).map((question) => question.anchor));
  const unlistedHere = (openHere ?? []).filter((anchor) => !listedHere.has(anchor)).length;
  const answeredHere = questions.items.length - entries.length;
  const more = Math.max(0, questions.count - questions.items.length);
  const total = Math.max(0, questions.count - answeredHere) + unlistedHere;
  const hereAnchors = [...listedHere, ...(openHere ?? []).filter((anchor) => !listedHere.has(anchor))];
  const only = attention.length === 0 && hereAnchors.length === 1 ? hereAnchors[0]! : null;
  // An approval shows its card while its tool block waits; a version card is in the loaded chat's timeline.
  const atEnd = only !== null && Boolean(openHere?.includes(only));
  const shown =
    atEnd ||
    (only !== null &&
      local !== null &&
      entries.some((question) => here(question) && question.anchor === only && question.kind !== "approval"));
  return {
    attention,
    entries: [...entries.filter(here).sort(byAsked), ...entries.filter((question) => !here(question)).sort(byAsked)],
    more,
    total: total + attention.length,
    // Only a card this chat shows can have its answers in view; without one, the row shows it.
    onlyHere: shown ? only : null,
    onlyHereAtEnd: atEnd,
  };
};

/** Preserve a row across reads only while all of its data, including its jump target, stays the same. */
export const sameWaitingQuestion = (a: AiOpenQuestion, b: AiOpenQuestion): boolean =>
  a.id === b.id &&
  a.kind === b.kind &&
  a.href === b.href &&
  a.conversationId === b.conversationId &&
  a.conversationTitle === b.conversationTitle &&
  a.anchor === b.anchor &&
  a.short === b.short &&
  a.createdAt === b.createdAt &&
  a.reason === b.reason &&
  a.app.name === b.app.name &&
  a.app.icon === b.app.icon &&
  a.app.accent === b.app.accent &&
  a.archivedChat?.id === b.archivedChat?.id &&
  a.archivedChat?.title === b.archivedChat?.title;
