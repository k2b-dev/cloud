import { dates, i18n } from "@k2b/stdlib";
import type { AiPendingTurnAction } from "@k2b/cloud/ai";
import { actionCardText, actionQuestionLines, approvalCard } from "@k2b/cloud/ai/browser";
import type { CloudCliContext } from "@k2b/cloud/cli";
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
  ctx: CloudCliContext,
  action: ApprovalAction,
  commands?: { approve: string; reject: string },
): { lines: string[]; hasRows: boolean } => {
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
    hasRows: text.rows.length > 0,
  };
};
