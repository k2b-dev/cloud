import type { AiTurnError } from "../types";
import { aiChatMessages } from "./messages";

/**
 * Whether a new message can pick up the work. A full context, a used-up quota, or lost access would fail the next
 * turn the same way; the reason then names the next step itself.
 */
export const aiTurnErrorCanContinue = (error: AiTurnError): boolean =>
  error.code !== "context_full" && error.code !== "quota_exhausted" && error.code !== "not_allowed" && error.code !== "provider_stopped";

/** What the chat shows under the title: the reason, and that the results so far are kept when the work can go on. */
export const aiTurnErrorDescription = (error: AiTurnError, locale: string): string => {
  const t = aiChatMessages(locale);
  return aiTurnErrorCanContinue(error) ? `${t.turnErrorReason(error)} ${t.turnErrorKept}` : t.turnErrorReason(error);
};

/** The turn's stored error for readers without the chat view, such as `cld`: the description and how to go on. */
export const aiTurnErrorText = (error: AiTurnError, locale: string): string =>
  aiTurnErrorCanContinue(error)
    ? `${aiTurnErrorDescription(error, locale)} ${aiChatMessages(locale).turnErrorContinueHint}`
    : aiTurnErrorDescription(error, locale);
