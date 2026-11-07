import { AppEventEnvelopeSchema } from "@k2b/cloud/contracts/app-events";
import { appEvents } from "@k2b/cloud/events";
import type { SQL } from "bun";
import { z } from "zod";
import type { chatCapabilities } from "./capabilities";
import { MAX_MENTIONS } from "./service/contracts";

const principal = z.strictObject({ type: z.enum(["user", "service_account"]), id: z.uuid() });
export const chatEvents = {
  "message.posted": {
    version: 1,
    title: "Message posted",
    description: "A new text message or reply was stored in a Chat conversation.",
    subject: "message",
    place: "conversation",
    schema: z.strictObject({
      threadReply: z.boolean(),
      root: z.strictObject({ type: z.literal("chat.message"), id: z.string().length(10) }).nullable(),
      author: principal,
      mentions: z.array(principal).max(MAX_MENTIONS),
    }),
  },
} as const;

// Resolve the platform binding lazily; handlers already import the message store.
const publisher = appEvents<typeof chatCapabilities>("chat");

/** Caller owns the domain transaction. The platform reconciles the committed outbox. */
export const publishMessagePosted = async (
  tx: SQL,
  input: { subject: string; place: string; requestId?: string; data: z.input<(typeof chatEvents)["message.posted"]["schema"]> },
): Promise<void> => {
  const requestId = AppEventEnvelopeSchema.shape.cause.unwrap().shape.requestId.safeParse(input.requestId);
  await publisher.publish(tx, "message.posted", { ...input, requestId: requestId.success ? requestId.data : undefined });
};

/** Only the owning send transaction calls this after commit. */
export const wakeChatEvents = (): void => publisher.wake();
