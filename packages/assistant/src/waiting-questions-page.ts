import { type AiOpenQuestion, type AiOpenQuestionsCursor, AiOpenQuestionsSchema } from "@k2b/cloud/contracts/open-questions";
import type { Setter } from "solid-js";
import { browserCodeInvoke } from "./frontend/code-client";

export type WaitingQuestionsPagingState = {
  items: AiOpenQuestion[];
  cursor?: AiOpenQuestionsCursor;
  loading?: boolean;
  failed?: boolean;
};

/** Paging work loads only on request; SSR and the first client frame own the same initial control and rows. */
export const loadMoreWaitingQuestions = async (
  current: WaitingQuestionsPagingState,
  update: Setter<WaitingQuestionsPagingState>,
  timeZone: string,
  signal: AbortSignal,
) => {
  try {
    const result = await browserCodeInvoke(
      { appId: "core", capabilityId: "ai.open_questions", kind: "query", input: { timeZone, cursor: current.cursor }, signal },
      AiOpenQuestionsSchema,
    );
    if (signal.aborted) return;
    if (!result.ok) {
      update({ ...current, failed: true });
      return;
    }
    const page = result.data.data;
    update({ items: [...new Map([...current.items, ...page.items].map((item) => [item.id, item])).values()], cursor: page.nextCursor });
  } catch {
    if (!signal.aborted) update({ ...current, failed: true });
  }
};
