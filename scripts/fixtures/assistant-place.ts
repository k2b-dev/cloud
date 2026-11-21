import { z } from "zod";
import { skill } from "../../packages/cloud/src/ai/app-skills";
import { actionReview } from "../../packages/cloud/src/capabilities/reviews";
import { AssistantPlaceSchema } from "../../packages/cloud/src/contracts/assistant-place";
import { type CapabilityExecutionContext, defineCapabilities } from "../../packages/cloud/src/contracts/capabilities";

export const PLACE_FIXTURE_APP_ID = "place-fixture";
export const PLACE_FIXTURE_TYPE = `${PLACE_FIXTURE_APP_ID}.conversation`;
export const PLACE_FIXTURE_PEOPLE = { lea: "00000000-0000-4000-8000-000000000001", ben: "00000000-0000-4000-8000-000000000002" };

/** Shared invented contact app: no built-in application is enabled for places in release one. */
export const createAssistantPlaceFixture = () => {
  const places = new Map([
    ["marta", { title: "Marta Example", context: "Customer asks about postage." }],
    ["jonas", { title: "Jonas Example", context: "Customer asks about an invoice." }],
  ]);
  const permissions = new Map<string, "read" | "write">([
    [`${PLACE_FIXTURE_PEOPLE.lea}:marta`, "write"],
    [`${PLACE_FIXTURE_PEOPLE.lea}:jonas`, "write"],
    [`${PLACE_FIXTURE_PEOPLE.ben}:marta`, "read"],
  ]);
  const calls: Array<{ person: string; target: string; text: string }> = [];
  const providerCalls: string[] = [];
  const read = (id: string, ctx: CapabilityExecutionContext) => {
    const permission = permissions.get(`${ctx.user?.id}:${id}`);
    const place = places.get(id);
    return place && permission ? { ...place, permission } : null;
  };
  const action = (reach: "you" | "shared") => ({
    title: "Write at this conversation",
    description: "Write a proposal at the current conversation.",
    target: "conversation",
    input: z.object({ text: z.string().max(500).describe("Text to write.") }).strict(),
    data: z.object({ written: z.boolean() }).strict(),
    destructive: false,
    openWorld: false,
    idempotency: "none" as const,
    policy: { silent: reach },
    review: async (_input: { text: string }, ctx: CapabilityExecutionContext) => ({
      ok: true as const,
      data: actionReview(
        {
          locale: "en",
          sentence: { action: "Write proposal", running: "Writing proposal", done: "Wrote proposal", confirm: "Write", decline: "Cancel" },
        },
        {},
        { scope: `conversation:${ctx.target?.id}` },
      ),
    }),
    run: async (input: { text: string }, ctx: CapabilityExecutionContext) => {
      const place = ctx.target && read(ctx.target.id, ctx);
      if (!place || place.permission !== "write")
        return { ok: false as const, error: { code: "FORBIDDEN", status: 403 as const, message: "Unavailable" } };
      calls.push({ person: ctx.user!.id, target: ctx.target!.id, text: input.text });
      return { ok: true as const, data: { data: { written: true } } };
    },
  });
  const capabilities = defineCapabilities({
    protocolVersion: 2,
    types: {
      conversation: {
        title: "Conversation",
        description: "An invented customer conversation.",
        reader: "conversation.read",
        assistant: {
          provider: "conversation.assistant",
          tools: ["reply.set", "note.add"],
          skills: ["contact-writing"],
        },
      },
    },
    queries: {
      "conversation.read": {
        title: "Read conversation",
        description: "Read an authorized conversation.",
        input: z.object({ id: z.string().describe("Conversation ID.") }).strict(),
        data: z.object({ title: z.string() }).strict(),
        openWorld: false,
        run: async (input, ctx) => {
          const place = read(input.id, ctx);
          return place
            ? { ok: true, data: { data: { title: place.title } } }
            : { ok: false, error: { code: "NOT_FOUND", status: 404, message: "Unavailable" } };
        },
      },
      "conversation.assistant": {
        title: "Assistant at conversation",
        description: "Return current context and tools for the person.",
        target: "conversation",
        input: z.object({}).strict(),
        data: AssistantPlaceSchema,
        openWorld: false,
        run: async (_input, ctx) => {
          providerCalls.push(ctx.target!.id);
          const place = read(ctx.target!.id, ctx);
          return place
            ? {
                ok: true,
                data: {
                  data: {
                    title: place.title,
                    context: place.context,
                    tools: place.permission === "write" ? ["reply.set", "note.add"] : [],
                    skills: ["contact-writing"],
                    starters: [{ label: "Shorten reply", prompt: "Make the reply shorter." }],
                  },
                },
              }
            : { ok: false, error: { code: "NOT_FOUND", status: 404, message: "Unavailable" } };
        },
      },
    },
    actions: { "reply.set": action("you"), "note.add": action("shared") },
  });
  const skills = [
    skill({
      markdown:
        "---\nname: contact-writing\ndescription: Write clear replies to customer questions in a contact conversation.\n---\nUse the conversation facts to prepare a concise reply. The person sends it.\n",
    }),
  ];
  return { capabilities, skills, places, permissions, calls, providerCalls, skillNames: new Set(skills.map((skill) => skill.name)) };
};
