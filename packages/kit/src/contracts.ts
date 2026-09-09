import { z } from "zod";

// Interactive source budget: at most 2 MiB per project, 64 modules and 1 MiB
// per module. This keeps parsing/bundling bounded on every save and preview.
export const LIMITS = {
  sourceBytes: 2 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  files: 64,
  nodes: 300,
  rows: 1000,
  logs: 200,
  text: 16000,
  pendingRequests: 32,
  rpcBytes: 16 * 1024 * 1024,
} as const;
export const PublicId = z.string().regex(/^[A-Za-z0-9]{6}$/);
export const FilePath = z
  .string()
  .max(180)
  .refine(
    (p) => /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.js$/.test(p) && p.split("/").every((s) => s !== "." && s !== ".."),
    "Expected a relative .js path",
  );
export const SourceFile = z.object({ path: FilePath, content: z.string().max(LIMITS.fileBytes) }).strict();
export const ProjectInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).default(""),
    persistenceEnabled: z.boolean().default(false),
    files: z.array(SourceFile).min(1).max(LIMITS.files),
  })
  .strict();
export const SaveInput = ProjectInput.extend({
  expectedRevision: z.number().int().positive(),
});
export const PrincipalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), userId: z.uuid() }),
  z.object({ type: z.literal("group"), groupId: z.uuid() }),
  z.object({ type: z.literal("authenticated") }),
]);
export const GrantInput = z
  .object({
    principal: PrincipalSchema,
    permission: z.enum(["read", "write", "admin"]),
  })
  .strict();
export type ProjectInput = z.infer<typeof ProjectInput>;
export type SourceFile = z.infer<typeof SourceFile>;
export type Entry = { path: string; name: string; icon: string; order: number };
export type Project = Omit<ProjectInput, "files"> & {
  id: string;
  revision: number;
  sdkVersion: number;
  updatedAt: string;
  permission: "none" | "read" | "write" | "admin";
};
export type Bundle = Project & { files: SourceFile[]; entries: Entry[] };
