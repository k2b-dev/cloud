import { capabilityUnknownText } from "../../_internal/capability-sentences";
import type { AiTurnBlock } from "../protocol";
import { toolOutcome } from "../tool-wording";
import { isRecord } from "./message-utils";
import { aiChatMessages } from "./messages";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

/** The application's own short summary of a result, if it fits on one line. */
const resultSummary = (block: ToolBlock): string | undefined => {
  const value = isRecord(block.result) ? block.result.summary : undefined;
  return typeof value === "string" && value.trim() && value.trim().length <= 500 ? value.trim() : undefined;
};

/** The words of a call without an app sentence: Cloud's frames around its catalog sentence or title. */
export const legacyOutcomeWords = (block: ToolBlock, locale: string, timeZone: string) => (subject: string) => {
  const t = aiChatMessages(locale);
  const capability = block.presentation?.kind === "capability";
  return {
    running: t.receiptRunning({ title: subject }),
    // The app's done sentence, else its own summary of the call, else Cloud's frame.
    done:
      toolOutcome(block, "done", locale, timeZone) ??
      resultSummary(block) ??
      (capability ? t.receiptDone({ title: subject }) : t.receiptApproved({ title: subject })),
    rejected: toolOutcome(block, "rejected", locale, timeZone) ?? t.receiptRejected({ title: subject }),
    notRun: toolOutcome(block, "notRun", locale, timeZone) ?? t.receiptNotRun({ title: subject, stopped: false }),
    unknown: capabilityUnknownText(subject, locale),
    unknownStill: capabilityUnknownText(subject, locale, true),
  };
};
