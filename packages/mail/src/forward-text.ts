/** The workspace omits forwardText when the original plain body already supplies it. */
export const messageForwardTextOf = (message: { plainText: string | null; forwardText?: string }): string =>
  message.plainText?.trim() ? message.plainText : (message.forwardText ?? "");
