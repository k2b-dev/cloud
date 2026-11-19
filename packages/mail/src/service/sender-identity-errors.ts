import { mailErrorMessages } from "../mail-error-messages";

/** Keep the mailbox-scoped address as data so every transport can localize this rejection. */
export const senderIdentityUnverified = (senderAddress: string | null = null) => ({
  code: "SENDER_IDENTITY_UNVERIFIED",
  status: 400 as const,
  senderAddress,
  message: mailErrorMessages.resolve(["en"]).t.senderUnverified({ address: senderAddress }),
});
