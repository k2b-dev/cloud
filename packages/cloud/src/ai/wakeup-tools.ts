import { z } from "zod";
import { defineAiTool } from "./tools";
import type { AiChatTurnRunConfig, AiToolRuntime } from "./types";
import { AiWakeupInputSchema, AiWakeupPatchSchema, AiWakeupSchema } from "./wakeup-contracts";
import { type AiWakeupAuthority, aiWakeups } from "./wakeups";

/** Chat identity comes from execution, never tool arguments. Restricted conversations receive no alarm tools. */
export function createAiWakeupTools(
  config: AiChatTurnRunConfig,
  chatId: string,
  turnId: string,
  allowedTools: string[] | null,
): AiToolRuntime[] {
  const actor = config.actor;
  if (
    !chatId ||
    config.toolSource?.kind !== "default" ||
    !config.assistantChat ||
    config.codeReview ||
    config.mandate ||
    config.background ||
    config.sourceRestricted ||
    allowedTools !== null ||
    actor?.kind !== "user" ||
    actor.sessionKind === "app" ||
    actor.delegation ||
    (config.turnTrigger?.kind !== "person" && config.turnTrigger?.kind !== "wakeup")
  )
    return [];
  const subject: AiWakeupAuthority = { actor, accessSubject: { type: "user", userId: actor.user.id }, turnId };
  const locale = config.locale ?? "en";
  return [
    defineAiTool({
      name: "wakeup_create",
      description:
        "Schedule ai.chat.send in this chat, once or on a five-field cron schedule with timezone. Only when the person asks for something later. At most five alarms; recurring intervals at least 15 minutes, end within 30 days; one-off within a year. Never create an alarm from an alarm turn.",
      inputSchema: AiWakeupInputSchema,
      outputSchema: AiWakeupSchema,
      approval: "never",
    }).server((input) => aiWakeups.create(chatId, input, subject, locale)),
    defineAiTool({
      name: "wakeup_list",
      description: "List this chat's current alarms, including missed and expired alarms, with their revisions.",
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({ items: z.array(AiWakeupSchema), limit: z.number(), paused: z.boolean() }),
      approval: "never",
      readOnly: true,
    }).server(() => aiWakeups.list(chatId, subject, locale)),
    defineAiTool({
      name: "wakeup_update",
      description:
        "Change this chat's alarm using its latest revision. In an alarm turn, only postpone that same alarm's at time, at most three times. To renew a recurring alarm, pass endsAt within 30 days from now.",
      inputSchema: AiWakeupPatchSchema.safeExtend({ id: z.uuid() }),
      outputSchema: AiWakeupSchema,
      approval: "never",
    }).server(({ id, ...input }) => aiWakeups.update(chatId, id, input, subject, locale)),
    defineAiTool({
      name: "wakeup_delete",
      description:
        "Delete this chat's alarm and cancel its waiting scheduled message. Supply its current revision. In an alarm turn, only delete that same alarm.",
      inputSchema: z.strictObject({ id: z.uuid(), revision: z.number().int().nonnegative() }),
      outputSchema: AiWakeupSchema,
      approval: "never",
    }).server(({ id, revision }) => aiWakeups.remove(chatId, id, revision, subject, locale)),
  ];
}
