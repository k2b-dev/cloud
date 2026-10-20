import { actionFixtures } from "./chat/action-question.fixtures";
import { type AiOpenQuestion, openQuestionFromRow } from "./open-questions";
import type { AiTurnBlock } from "./protocol";

/**
 * Demo Assistant questions for host tests and screenshots, in German and English, with fixed times. The demo data may
 * change in any release: assert on what your host renders from it, not on its wording.
 */
export const aiQuestionFixtures = (locale: "de" | "en"): Record<string, { block: Extract<AiTurnBlock, { kind: "tool" }> }> =>
  actionFixtures(locale);

/** A waiting question as `listAiOpenQuestions` presents it from the chat's tool block. */
export const aiOpenQuestionFixture = (
  input: {
    id: string;
    conversationId: string;
    conversationTitle: string | null;
    createdAt: string;
    block: Extract<AiTurnBlock, { kind: "tool" }>;
  },
  context: { locale: string; timeZone: string },
): AiOpenQuestion =>
  openQuestionFromRow(
    {
      id: input.id,
      conversationId: input.conversationId,
      conversationTitle: input.conversationTitle,
      displayCallId: input.block.callId,
      appId: input.block.presentation?.kind === "capability" ? input.block.presentation.appId : "core",
      sentence: "",
      toolName: input.block.name,
      createdAt: new Date(input.createdAt),
      block: input.block,
    },
    context,
  );
