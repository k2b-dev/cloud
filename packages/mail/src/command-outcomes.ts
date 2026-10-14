/** At most this many commands per outcome request, the same ceiling as one page of a Mail list. */
export const MAX_COMMAND_OUTCOME_IDS = 100;

/** The most provider messages one conversation action may change, and so the most commands one Undo request names. */
export const MAX_CONVERSATION_ACTION_MESSAGES = 500;
