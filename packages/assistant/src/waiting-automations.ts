import { z } from "zod";
import { type CodeQueryInvoke, CodeSummaryError } from "./code-summary";

/**
 * The person's own Code that waits for them: the few fields "Waiting for you" shows from Core's open questions. A module
 * of its own, so the chat's bundle loads it only when the page opens without the server's read.
 */
const WaitingAutomationsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.literal("code_attention"),
      href: z.string().optional(),
      short: z.string(),
      reason: z.enum(["chat_missing", "secret", "mandate", "access"]).optional(),
    }),
  ),
});
export type WaitingAutomation = z.infer<typeof WaitingAutomationsSchema>["items"][number];

/**
 * Only the `code_attention` kind, in the feed's own page size: older questions never push the person's automations
 * out of the section. The server's first render and the browser read the same.
 */
export const loadWaitingAutomations = async (invoke: CodeQueryInvoke, timeZone: string): Promise<WaitingAutomation[]> => {
  const result = await invoke(
    { appId: "core", capabilityId: "ai.open_questions", kind: "query", input: { timeZone, kind: "code_attention" } },
    WaitingAutomationsSchema,
  );
  if (!result.ok) throw new CodeSummaryError(result.error.message);
  return result.data.data.items;
};
