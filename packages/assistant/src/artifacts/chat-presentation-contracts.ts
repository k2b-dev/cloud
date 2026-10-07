import { CodeResourceId } from "@k2b/cloud/ai/browser";
import { z } from "zod";
import { ArtifactFile, LIMITS } from "./contracts";

/** An HTML app shown in a chat: one-off files without saved data, or a saved app that runs live with its data. */
export const ChatPresentationInput = z
  .object({
    conversationId: z.string().min(1).max(80),
    callId: z.string().min(1).max(180),
    title: z.string().trim().min(1).max(120),
    files: z.array(ArtifactFile).min(1).max(LIMITS.files).optional(),
    artifactId: CodeResourceId.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.files === undefined) === (value.artifactId === undefined))
      ctx.addIssue({ code: "custom", message: "Present either files or a saved app" });
    if (!value.files) return;
    if (!value.files.some((file) => file.path === "index.html")) ctx.addIssue({ code: "custom", message: "An app needs index.html" });
    if (new Set(value.files.map((file) => file.path)).size !== value.files.length)
      ctx.addIssue({ code: "custom", message: "Duplicate file paths" });
    if (new TextEncoder().encode(JSON.stringify(value.files)).byteLength > LIMITS.sourceBytes)
      ctx.addIssue({ code: "custom", message: "Source exceeds byte budget" });
  });
export const ChatPresentation = z.object({
  id: z.uuid(),
  conversationId: z.string(),
  title: z.string(),
  files: z.array(ArtifactFile).nullable(),
  /** Short ID of the saved app, when the card shows one. */
  artifactId: z.string().nullable(),
});
export type ChatPresentation = z.infer<typeof ChatPresentation>;
export const ChatPresentationResult = z.object({ presentationId: z.uuid(), title: z.string() });
