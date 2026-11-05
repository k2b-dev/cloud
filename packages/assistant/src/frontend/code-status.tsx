import { StatusBadge, type StatusTone, useLocale } from "@k2b/ui";
import { type CodeStatusKey, type CodeStatusTone, type CodeSummary, codeStatus } from "../code-summary";
import { formatCodeTime } from "./code-client";
import { assistantMessages } from "./messages";

// The status words and run lines that the Code list and the panel's Code block share. The list loads when it opens,
// so the block on the panel's first frame takes them from here.

const badgeTone: Record<CodeStatusTone, StatusTone> = { success: "ok", warning: "warning", danger: "error", neutral: "neutral" };

export function CodeStatusBadge(props: { code: CodeSummary; status?: { key: CodeStatusKey; tone: CodeStatusTone } }) {
  const locale = useLocale();
  const status = () => props.status ?? codeStatus(props.code);
  return <StatusBadge tone={badgeTone[status().tone]} variant="dot" label={codeStateLabel(status().key, locale())} />;
}

/** The visible word for one Code status. */
export const codeStateLabel = (key: CodeStatusKey, locale: string) => {
  const t = assistantMessages.resolve([locale]).t;
  return {
    on: t.codeStateOn,
    paused: t.codeStatePaused,
    draft: t.codeStateDraft,
    deleting: t.codeStateDeleting,
    failed: t.codeStateFailed,
    access_missing: t.codeStateAccessMissing,
  }[key];
};

/** When the newest run ended or started, that none ran yet, or that Core could not say. */
export const codeRunTime = (code: CodeSummary, locale: string, timeZone: string) => {
  const t = assistantMessages.resolve([locale]).t;
  const run = code.lastRun;
  if (run === undefined) return t.codeRunUnknown;
  return run ? formatCodeTime(run.endedAt ?? run.createdAt, locale, timeZone) : t.codeNoRun;
};

/** The line under a Code's name in the panel block: its newest run. */
export const codeRunLine = (code: CodeSummary, locale: string, timeZone: string) => {
  const t = assistantMessages.resolve([locale]).t;
  return code.lastRun ? t.codeLastRun({ when: codeRunTime(code, locale, timeZone) }) : codeRunTime(code, locale, timeZone);
};
