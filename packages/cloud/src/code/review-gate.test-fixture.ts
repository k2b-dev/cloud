import { z } from "zod";
import { compileCapabilityManifest } from "../capabilities/testing";
import { CloudResourceReaderViewSchema, defineCapabilities } from "../contracts/capabilities";

const review = (action: string) => () => ({
  ok: true as const,
  data: {
    locale: "en",
    sentence: { action, running: action, done: action, confirm: action, decline: "Cancel" },
    slots: {},
    scope: "message",
  },
});

/**
 * Fictional outbox app for the "review before sending" pattern: it holds a message as submitted, raises an event and
 * sends or reopens the draft only through its own approve and reject Actions. No installed application is special.
 */
export const reviewGateManifest = () =>
  compileCapabilityManifest(
    "outbox",
    defineCapabilities({
      protocolVersion: 2,
      code: { owners: ["queue"] },
      types: {
        queue: {
          title: "Outbox",
          description: "A queue of outgoing messages.",
          reader: "queue.read",
          access: { readable: async () => [] },
        },
        message: { title: "Outgoing message", description: "A message waiting for review.", reader: "message.read" },
      },
      queries: {
        "queue.read": {
          title: "Read outbox",
          description: "Read one outbox.",
          openWorld: false,
          input: z.object({ id: z.string().describe("Outbox ID.") }).strict(),
          data: z.object({ view: CloudResourceReaderViewSchema }).strict(),
          run: () => ({ ok: false as const, error: { code: "NOT_FOUND", message: "Missing", status: 404 as const } }),
          codeResourceTitle: async () => "Outbox",
        },
        "message.read": {
          title: "Read outgoing message",
          description: "Read one submitted message with its recipient, subject and text.",
          openWorld: false,
          input: z.object({ id: z.string().describe("Message ID.") }).strict(),
          data: z
            .object({
              id: z.string(),
              state: z.enum(["draft", "in_review", "sent", "rejected"]),
              revision: z.number().int().positive().describe("Increases each time the author submits the message again."),
              recipient: z.string(),
              subject: z.string(),
              text: z.string(),
            })
            .strict(),
          run: () => ({ ok: false as const, error: { code: "NOT_FOUND", message: "Missing", status: 404 as const } }),
        },
      },
      actions: {
        "message.approve": {
          title: "Approve message",
          description:
            "Release a message its author already chose to send and that is still in review at this revision; the outbox sends it. Cannot change the text.",
          input: z
            .object({ id: z.string().describe("Message ID."), revision: z.number().int().positive().describe("Revision in review.") })
            .strict(),
          data: z.object({ state: z.enum(["sent", "in_review"]) }).strict(),
          destructive: false,
          openWorld: false,
          idempotency: "required",
          policy: { silent: "shared" },
          review: review("Approve message"),
          run: () => ({ ok: true, data: { data: { state: "sent" as const } } }),
        },
        "message.reject": {
          title: "Return message",
          description: "Return a message in review to its draft with a reason and a suggestion.",
          input: z
            .object({
              id: z.string().describe("Message ID."),
              revision: z.number().int().positive().describe("Revision in review."),
              reason: z.string().min(1).max(500).describe("Why the message cannot go out."),
              suggestion: z.string().max(4000).describe("A suggested change for the author."),
            })
            .strict(),
          data: z.object({ state: z.enum(["rejected", "in_review"]) }).strict(),
          destructive: false,
          openWorld: false,
          idempotency: "required",
          policy: { silent: "shared" },
          review: review("Return message"),
          run: () => ({ ok: true, data: { data: { state: "rejected" as const } } }),
        },
      },
      events: {
        "message.submitted": {
          title: "Message submitted",
          description: "A message entered review before sending.",
          version: 1,
          subject: "message",
          place: "queue",
          schema: z.object({}).strict(),
        },
      },
    }),
  );
