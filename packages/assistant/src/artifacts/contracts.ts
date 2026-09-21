import { z } from "zod";

// Interactive source and worker budgets.
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
  // Match the existing Assistant chat-file defaults (checked in contracts.test).
  inputFileBytes: 50 * 1024 * 1024,
  inputBytes: 250 * 1024 * 1024,
} as const;

export const ArtifactPath = z
  .string()
  .min(1)
  .max(180)
  .refine(
    (path) => /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path) && path.split("/").every((part) => part !== "." && part !== ".."),
    "Expected a relative file path without traversal",
  );
export const ArtifactFile = z
  .object({
    path: ArtifactPath.describe("Relative file path within this artifact, for example main.ts."),
    content: z
      .string()
      .max(LIMITS.fileBytes)
      .describe("Complete UTF-8 source file content. Read an existing file completely before replacing it."),
  })
  .strict();
export const ArtifactSource = z
  .object({
    entry: ArtifactPath.describe("JavaScript or TypeScript entry path; execution requires that file to export one function."),
    files: z.array(ArtifactFile).max(LIMITS.files).describe("Complete source bundle with unique relative paths."),
  })
  .strict()
  .superRefine((source, ctx) => {
    const paths = new Set(source.files.map((file) => file.path));
    if (paths.size !== source.files.length) ctx.addIssue({ code: "custom", message: "Duplicate file paths" });
    if (!/\.(?:js|ts)$/.test(source.entry)) ctx.addIssue({ code: "custom", message: "Entry must be a JavaScript or TypeScript path" });
    const encoder = new TextEncoder();
    let total = 0;
    for (const file of source.files) {
      const size = encoder.encode(file.content).byteLength;
      total += size;
      if (size > LIMITS.fileBytes) ctx.addIssue({ code: "custom", message: `File exceeds byte budget: ${file.path}` });
    }
    if (total > LIMITS.sourceBytes) ctx.addIssue({ code: "custom", message: "Source exceeds byte budget" });
  });
export type ArtifactSource = z.infer<typeof ArtifactSource>;

export const ArtifactKind = z.literal("app");
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const ArtifactIcon = z
  .string()
  .regex(/^ti ti-[a-z0-9-]+$/)
  .max(80);
export const PublicationNote = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .describe("Concise user-facing explanation of this publication or rollback.");
export const ArtifactMetadata = z
  .object({
    title: z.string().trim().min(1).max(120).optional().describe("New working application title."),
    description: z.string().trim().max(500).optional().describe("New working application description."),
    icon: ArtifactIcon.optional().describe("Tabler icon class, for example ti ti-calculator."),
  })
  .strict();

export const ArtifactCreate = z
  .object({
    kind: ArtifactKind.default("app").describe(
      "Reusable App with optional GUI, actions and persistence. One-off code_run needs no resource.",
    ),
    title: z.string().trim().min(1).max(120).describe("Short user-facing app title."),
    description: z.string().trim().max(500).optional().describe("One or two sentences explaining what this app does."),
    icon: ArtifactIcon.optional().describe("Tabler icon class, for example ti ti-calculator."),
    source: ArtifactSource.describe("Initial source bundle. Creating an app does not execute it."),
  })
  .strict();
export const ArtifactUpdate = ArtifactCreate.omit({ kind: true }).extend({ expectedRevision: z.number().int().positive() });
export type ArtifactPermission = "use" | "manage";
