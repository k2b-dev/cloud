import { createHash } from "node:crypto";
import { sql } from "@k2b/cloud";
import { AI_SHORT_ID_PATTERN, aiConversations, aiProjects } from "@k2b/cloud/ai";
import { AiConversationCreationError } from "@k2b/cloud/ai/runtime";
import { type CapabilityExecutionContext, CapabilityIdempotencyKeySchema, capabilityIdempotencyConflict } from "@k2b/cloud/contracts";
import { accounts } from "@k2b/cloud/services";
import { isAccountExpired } from "@k2b/cloud/services/account-model";
import { err, fail, ok } from "@k2b/stdlib";
import { z } from "zod";
import { chatWriteAuthority } from "./ai-code-chat";

export const aiChatCreateInput = z.strictObject({
  title: z.string().trim().min(1).max(200).describe("Title of the new personal chat, 1 to 200 characters."),
  project: z
    .strictObject({
      type: z.literal("core.ai.project").describe("Project resource type."),
      id: z.string().regex(AI_SHORT_ID_PATTERN).describe("Public short ID of a readable Project."),
    })
    .optional()
    .describe("Optional Project for the new chat; current read access is required."),
});
export const aiChatCreateData = z.strictObject({
  chat: z.strictObject({ type: z.literal("core.ai.chat"), id: z.string() }),
  open: z.string(),
});

/** Domain-separated UUIDv8: the existing durable creation receipt owns replay. */
const creationRequestId = (userId: string, key: string) => {
  const digest = createHash("sha256")
    .update(JSON.stringify([userId, "ai.chat.create", key]))
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const readableProject = (input: z.output<typeof aiChatCreateInput>, context: CapabilityExecutionContext) =>
  input.project ? aiProjects.getByShortId(input.project.id, context, "read") : Promise.resolve(null);

export const aiChatCreateAction = {
  title: "Create a new chat",
  description:
    "Create an empty personal chat, optionally in a readable Project. Reuse the same key and input to recover the original chat. Restricted sources, service accounts and chat chains cannot create chats. Use ai.chat.send separately to start a turn.",
  input: aiChatCreateInput,
  data: aiChatCreateData,
  destructive: false,
  openWorld: false,
  idempotency: "required" as const,
  policy: { silent: "you" as const },
  async review(input: z.output<typeof aiChatCreateInput>, context: CapabilityExecutionContext) {
    const authority = await chatWriteAuthority(context, sql);
    if (!authority.ok) return authority;
    const project = await readableProject(input, context);
    if (input.project && !project) return fail(err.notFound("Project"));
    const de = context.locale.split("-")[0] === "de";
    return ok({
      locale: de ? "de" : "en",
      reach: "you" as const,
      slots: {
        title: {
          kind: "text" as const,
          value: input.title.replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, " ").trim() || (de ? "Neuer Chat" : "New chat"),
        },
      },
      sentence: {
        action: de ? "Chat {title} erstellen" : "Create chat {title}",
        running: de ? "Chat {title} wird erstellt" : "Creating chat {title}",
        done: de ? "Chat {title} erstellt" : "Created chat {title}",
        confirm: de ? "Chat erstellen" : "Create chat",
        decline: de ? "Abbrechen" : "Cancel",
        rejected: de ? "Erstellen von Chat {title} abgelehnt" : "Declined creating chat {title}",
        notRun: de ? "Chat {title} nicht erstellt" : "Did not create chat {title}",
        short: de ? "Chat erstellt" : "Chat created",
      },
      view: {
        version: 1 as const,
        blocks: [
          {
            kind: "Draft" as const,
            context: project ? [{ label: de ? "Projekt" : "Project", value: project.name }] : [],
            fields: [{ name: "title", label: de ? "Titel" : "Title", type: "text" as const, value: input.title }],
          },
        ],
      },
    });
  },
  async run(input: z.output<typeof aiChatCreateInput>, context: CapabilityExecutionContext) {
    const authority = await chatWriteAuthority(context, sql);
    if (!authority.ok) return authority;
    if (!context.user) return fail(err.forbidden("Creating chats requires their owner"));
    const key = CapabilityIdempotencyKeySchema.safeParse(context.idempotencyKey);
    const parsed = aiChatCreateInput.safeParse(input);
    if (!key.success || !parsed.success) return fail(err.badInput("Supply a title and a valid idempotency key"));
    const owner = await accounts.users.get({ id: context.user.id });
    if (!owner || isAccountExpired(owner.accountExpires)) return fail(err.forbidden("The chat owner is inactive"));
    const project = await readableProject(parsed.data, context);
    if (parsed.data.project && !project) return fail(err.notFound("Project"));
    try {
      const chat = await aiConversations.createConversation({
        requestId: creationRequestId(owner.id, key.data),
        ownerUserId: owner.id,
        title: parsed.data.title,
        projectId: project?.id,
      });
      // Replays can return a chat moved to another Project since creation, just as on the HTTP route.
      if (chat.projectId && chat.projectId !== project?.id && !(await aiProjects.get(chat.projectId, context, "read")))
        return fail(err.notFound("Project"));
      const ref = { type: "core.ai.chat", id: chat.shortId };
      const open = `/app/assistant?conversation=${encodeURIComponent(chat.shortId)}`;
      return ok({ data: { chat: ref, open }, refs: [ref], links: [{ rel: "open" as const, href: open }] });
    } catch (error) {
      if (!(error instanceof AiConversationCreationError)) throw error;
      if (error.reason === "project_unavailable") return fail(err.notFound("Project"));
      return error.reason === "conflict"
        ? fail(
            capabilityIdempotencyConflict(
              context.locale.split("-")[0] === "de"
                ? "Dieser Schlüssel wurde bereits mit einem anderen Titel oder Projekt verwendet."
                : error.message,
            ),
          )
        : fail({
            code: "chat_unavailable",
            message:
              context.locale.split("-")[0] === "de"
                ? "Der mit diesem Schlüssel erstellte Chat ist nicht mehr verfügbar. Es wurde kein Ersatz erstellt."
                : "The chat created with this key is no longer available. No replacement was created.",
            status: 409 as const,
          });
    }
  },
};
