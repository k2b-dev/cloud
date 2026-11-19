import { type AiOpenQuestionsCursor, AiOpenQuestionsSchema } from "@k2b/cloud/contracts/open-questions";
import { type CodeQueryInvoke, CodeSummaryError } from "./code-summary";

/** One more authorized page; the first page belongs to SSR and the shared sidebar read. */
export const loadWaitingQuestionsPage = async (
  invoke: CodeQueryInvoke,
  timeZone: string,
  cursor: AiOpenQuestionsCursor,
  signal: AbortSignal,
) => {
  const result = await invoke(
    { appId: "core", capabilityId: "ai.open_questions", kind: "query", input: { timeZone, cursor }, signal },
    AiOpenQuestionsSchema,
  );
  if (!result.ok) throw new CodeSummaryError(result.error.message);
  return result.data.data;
};
