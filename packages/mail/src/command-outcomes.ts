/** At most this many commands per outcome request, the same ceiling as one page of a Mail list. */
export const MAX_COMMAND_OUTCOME_IDS = 100;

/** The most provider messages one conversation action may change, and so the most commands one Undo request names. */
export const MAX_CONVERSATION_ACTION_MESSAGES = 500;

/** How long the list follows an action's outcome and a recorded Undo may create an inverse after its first request. */
export const MAIL_ACTION_OUTCOME_TTL_MS = 15 * 60_000;
