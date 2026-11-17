import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import type { AiTurnBlock } from "../protocol";
import { toolOutcome, toolSubject, useReaderTimeZone } from "./action-sentences";
import { isRecord } from "./message-utils";
import { aiChatMessages } from "./messages";

// Loaded with the opened work list; these detail-only words add nothing to the initial Assistant island.
const messages = /* @__PURE__ */ i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      working: "Gustav is processing the data for your request.",
      completed: "The run finished processing the data for your request.",
      rejected: "The requested action was not approved.",
      stopped: "The run was stopped. Changes already made may remain.",
    },
    de: {
      working: "Gustav verarbeitet die Daten für deine Anfrage.",
      completed: "Der Lauf hat die Daten für deine Anfrage verarbeitet.",
      rejected: "Die angefragte Aktion wurde nicht freigegeben.",
      stopped: "Der Lauf wurde gestoppt. Bereits vorgenommene Änderungen können bestehen bleiben.",
    },
  },
});

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
export const isCodeRunStep = (name: string): boolean => name === "code_run" || name === "code_inspect";

/** The stored review describes the effect; raw modules, output and diagnostic logs stay out of the step body. */
export function CodeRunStepBody(props: { block: ToolBlock }) {
  const locale = useLocale();
  const timeZone = useReaderTimeZone();
  const description = () => {
    const block = props.block;
    const t = messages.resolve([locale()]).t;
    const result = isRecord(block.result) ? block.result : null;
    const work = result && isRecord(result.work) ? result.work : null;
    const hasAppDescription = block.review || block.approval?.review || block.presentation?.kind === "capability";
    if (block.status === "failed" || block.isError || result?.failed === true || result?.status === "error" || work?.status === "error")
      return aiChatMessages(locale()).codeStepFailed;
    if (block.status === "rejected") return (hasAppDescription && toolOutcome(block, "rejected", locale(), timeZone)) || t.rejected;
    if (block.status !== "completed") return (hasAppDescription && toolSubject(block, locale(), timeZone)) || t.working;
    if (result?.status === "stopped" || work?.status === "cancelled") return t.stopped;
    if (result?.status === "starting" || work?.status === "running") return t.working;
    return (hasAppDescription && toolOutcome(block, "done", locale(), timeZone)) || t.completed;
  };
  return <p class="ai-code-step__note">{description()}</p>;
}
