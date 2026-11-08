import { AssistantPlaceSchema, type CapabilityExecutionContext, defineCapabilities } from "@k2b/cloud/contracts";
import { z } from "zod";

export const createPlaceCapabilities = (conversations: {
  read(id: string, ctx: CapabilityExecutionContext): Promise<{ title: string; summary: string }>;
}) =>
  defineCapabilities({
    protocolVersion: 2,
    types: {
      conversation: {
        title: "Conversation",
        description: "A customer conversation.",
        reader: "conversation.read",
        assistant: {
          provider: "conversation.assistant",
          tools: [],
          skills: [],
        },
      },
    },
    queries: {
      "conversation.read": {
        title: "Read conversation",
        description: "Read an authorized customer conversation.",
        input: z.object({ id: z.string().describe("Conversation ID.") }).strict(),
        data: z.object({ title: z.string() }).strict(),
        openWorld: false,
        run: async (input, ctx) => {
          const conversation = await conversations.read(input.id, ctx);
          return { ok: true, data: { data: { title: conversation.title } } };
        },
      },
      "conversation.assistant": {
        title: "Assistant context",
        description: "Read the person's current context at this conversation.",
        target: "conversation",
        input: z.object({}).strict(),
        data: AssistantPlaceSchema,
        openWorld: false,
        run: async (_input, ctx) => {
          if (!ctx.target) throw new Error("Conversation target required");
          const conversation = await conversations.read(ctx.target.id, ctx);
          return {
            ok: true,
            data: {
              data: {
                title: conversation.title,
                context: conversation.summary,
                tools: [],
                skills: [],
                starters: [{ label: "Summarize", prompt: "Summarize this conversation." }],
              },
            },
          };
        },
      },
    },
  });
