import { z } from "zod";

/** A location is explicit; it never grants access or mounts a whole store. */
export const AiFileLocation = z
  .object({
    scope: z.enum(["chat", "project", "app"]),
    id: z.string().min(1).max(80).describe("Exact chat, Project or App ID; returned locations use canonical IDs."),
    path: z.string().min(1).max(500).describe("Exact path/key returned by the owning file store."),
  })
  .strict();
export const AiFileReference = AiFileLocation.extend({
  version: z.string().min(1).max(128).describe("Opaque version returned by code_file_stat. Never guess it."),
});
export type AiFileLocation = z.infer<typeof AiFileLocation>;
export type AiFileReference = z.infer<typeof AiFileReference>;
