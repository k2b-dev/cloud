import type { AiPendingTurnAction } from "@k2b/cloud/ai";
import { actionCardText, actionQuestionLines, approvalCard } from "@k2b/cloud/ai/question-text";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { dates, i18n } from "@k2b/stdlib";
import { terminalSafeText } from "./terminal";

type ApprovalAction = Extract<AiPendingTurnAction, { type: "approval_request" }>;

export const actionOriginMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      chat: ({ title }: { title: string }) => `Chat “${title}”`,
      expires: ({ at }: { at: string }) => `open until ${at}`,
    },
    de: {
      chat: ({ title }: { title: string }) => `Chat „${title}“`,
      expires: ({ at }: { at: string }) => `offen bis ${at}`,
    },
  },
});

/** One shared card supplies every terminal question, including old reviews and unreviewed calls. */
export const pendingActionQuestion = (
  ctx: Pick<CloudCliContext, "options">,
  action: ApprovalAction,
  commands?: { approve: string; reject: string },
): { lines: string[]; showInput: boolean } => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const card = approvalCard(
    {
      sentence: action.message ?? action.name,
      action: action.name,
      appName: action.app?.name ?? "Cloud",
      appIcon: "ti ti-shield-check",
      review: action.review ?? null,
    },
    ctx.options.locale ?? "en",
    timeZone,
  );
  const text = actionCardText(card);
  if (text.readMore?.startsWith("/")) text.readMore = `${ctx.options.server.replace(/\/+$/, "")}${text.readMore}`;
  const t = actionOriginMessages.resolve([text.locale]).t;
  const origin = [
    action.app?.name,
    action.chatTitle ? t.chat({ title: action.chatTitle }) : undefined,
    action.expiresAt ? t.expires({ at: dates.formatDateTime(action.expiresAt, { locale: text.locale, timeZone }) }) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    lines: actionQuestionLines(text, { ...(origin ? { origin } : {}), ...(commands ? { commands } : {}), timeZone }).map(terminalSafeText),
    // Only an app's review describes the call; without one, or when the question leaves something out and no link
    // opens it, the validated input stays the way to see everything before deciding.
    // An old review cannot say whether it shortened anything, so its input stays visible as before.
    showInput: !action.review || !("sentence" in action.review) || (text.incomplete && !text.readMore),
  };
};
