import { appEvents } from "@k2b/cloud/events";
import type { SQL } from "bun";
import { z } from "zod";
import type { mailCapabilities } from "./capabilities";

export const mailEvents = {
  "message.received": {
    version: 1,
    title: "Message received",
    description: "An incoming message reached its first eligible placement in a mailbox.",
    subject: "message",
    place: "mailbox",
    schema: z.strictObject({ receiptId: z.uuid() }),
  },
} as const;

// Resolve the platform binding lazily; capability handlers import the Mail services.
const publisher = appEvents<typeof mailCapabilities>("mail");

/** The caller owns the receipt transaction; the platform reconciles its committed outbox. */
export const publishMessageReceived = async (tx: SQL, messageId: string, mailboxId: string, receiptId: string): Promise<void> => {
  const [refs] = await tx<{ message: string; mailbox: string }[]>`
    SELECT message.short_id AS message, mailbox.short_id AS mailbox
    FROM mail.message_contents message
    JOIN mail.mailboxes mailbox ON mailbox.id = message.mailbox_id
    WHERE message.id = ${messageId}::uuid AND mailbox.id = ${mailboxId}::uuid
  `;
  if (!refs) throw new Error("Mail receipt event names a missing message or mailbox");
  await publisher.publish(tx, "message.received", {
    subject: refs.message,
    place: refs.mailbox,
    data: { receiptId },
  });
};
