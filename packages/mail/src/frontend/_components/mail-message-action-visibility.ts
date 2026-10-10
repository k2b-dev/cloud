export type MailMessageActionVisibility = {
  findSender: boolean;
  createIncomingAutomation: boolean;
  blockSender: boolean;
  manageUnsubscribe: boolean;
  conversationRepair: boolean;
  editAsNew: boolean;
  reportPhishing: boolean;
};

export const resolveMailMessageActionVisibility = (input: {
  outgoing: boolean;
  hasSender: boolean;
  hasMailingListUnsubscribe: boolean;
  hasConversation: boolean;
  totalMessageCount: number;
  canWrite: boolean;
  canAdmin: boolean;
  /** False for a person who sees only the conversations assigned to them: these actions reach beyond them. */
  mailboxWide: boolean;
}): MailMessageActionVisibility => {
  const externalSender = input.hasSender && !input.outgoing;
  const multiMessageConversation = input.hasConversation && input.totalMessageCount > 1;
  return {
    findSender: externalSender,
    createIncomingAutomation: externalSender && input.canAdmin,
    blockSender: externalSender && input.canAdmin,
    manageUnsubscribe: externalSender && input.canWrite && input.mailboxWide && input.hasMailingListUnsubscribe,
    conversationRepair: input.canWrite && input.mailboxWide && multiMessageConversation,
    editAsNew: input.canWrite && input.mailboxWide,
    reportPhishing: input.mailboxWide,
  };
};
