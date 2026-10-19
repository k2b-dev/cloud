import type { AiOpenQuestion, AiOpenQuestions, AiTurnBlock } from "@k2b/cloud/ai";

/** What the "Waiting for you" strip shows above the composer. */
export type WaitingQuestionsView = {
  /** Open questions of this chat first, in the order they were asked, then those of other chats. */
  entries: AiOpenQuestion[];
  /** Open questions the server's bounded read left out; the strip offers them through the Approvals view. */
  more: number;
  /** All open questions of the person. The strip keeps its place while this is above zero. */
  total: number;
  /** The anchor of the only open question when it waits in this chat: the strip then shows only while its answers are out of view. */
  onlyHere: string | null;
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
}): WaitingQuestionsView => {
  const { questions, conversationId, local } = input;
  const here = (question: AiOpenQuestion) => conversationId !== null && question.conversationId === conversationId;
  const localTools = local ? local.filter((block) => block.kind === "tool") : null;
  const openHere = localTools ? localTools.filter((block) => block.status === "awaiting_approval").map((block) => block.id) : null;
  const known = localTools ? new Set(localTools.map((block) => block.id)) : null;
  // A block this chat shows decides; one it does not show yet stays as the server read it.
  const stillOpen = (question: AiOpenQuestion) =>
    !here(question) || !known?.has(question.anchor) || Boolean(openHere?.includes(question.anchor));
  const entries = questions.items.filter(stillOpen);
  const listedHere = new Set(entries.filter(here).map((question) => question.anchor));
  const unlistedHere = (openHere ?? []).filter((anchor) => !listedHere.has(anchor)).length;
  const answeredHere = questions.items.length - entries.length;
  const more = Math.max(0, questions.count - questions.items.length);
  const total = Math.max(0, questions.count - answeredHere) + unlistedHere;
  const hereAnchors = [...listedHere, ...(openHere ?? []).filter((anchor) => !listedHere.has(anchor))];
  return {
    entries: [...entries.filter(here).sort(byAsked), ...entries.filter((question) => !here(question)).sort(byAsked)],
    more,
    total,
    onlyHere: total === 1 && hereAnchors.length === 1 ? hereAnchors[0]! : null,
  };
};
