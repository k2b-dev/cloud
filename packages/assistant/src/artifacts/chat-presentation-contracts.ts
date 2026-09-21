import { z } from "zod";
import { LIMITS } from "./contracts";
import { validateTree } from "./runtime/host";
import { UiNode } from "./runtime/protocol";

const PresentationFields = z
  .object({
    conversationId: z.string().min(1).max(80),
    callId: z.string().min(1).max(180),
    title: z.string().trim().min(1).max(120),
    code: z.string().min(1).max(LIMITS.fileBytes),
    nodes: z.array(UiNode).min(1).max(LIMITS.nodes),
    inputs: z.array(z.object({ path: z.string().min(1).max(500), version: z.number().int().positive() }).strict()).max(LIMITS.files),
  })
  .strict();
export const ChatPresentationInput = PresentationFields.superRefine((value, ctx) => {
  if (new TextEncoder().encode(value.code).byteLength > LIMITS.fileBytes)
    ctx.addIssue({ code: "custom", message: "Source exceeds file byte budget" });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > LIMITS.rpcBytes)
    ctx.addIssue({ code: "custom", message: "Presentation exceeds the runtime message budget" });
  if (new Set(value.inputs.map((file) => file.path)).size !== value.inputs.length)
    ctx.addIssue({ code: "custom", message: "Input paths must be unique" });
  try {
    validateTree(value.nodes);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: String(error) });
  }
});
export const ChatPresentation = PresentationFields.omit({ callId: true, inputs: true }).extend({
  id: z.uuid(),
  inputs: z.array(z.object({ path: z.string(), size: z.number(), mediaType: z.string() })),
});
export type ChatPresentation = z.infer<typeof ChatPresentation>;
export const ChatPresentationResult = z.object({ presentationId: z.uuid(), title: z.string() });
