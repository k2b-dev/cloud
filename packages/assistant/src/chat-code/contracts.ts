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
  // Matches the default Core worker concurrency before Chromium allocation.
  codeHosts: 8,
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
    entry: ArtifactPath.describe(
      "index.html for an app with an interface; otherwise the JavaScript or TypeScript script that code_run executes (it exports one function).",
    ),
    files: z.array(ArtifactFile).max(LIMITS.files).describe("Complete source bundle with unique relative paths."),
  })
  .strict()
  .superRefine((source, ctx) => {
    const paths = new Set(source.files.map((file) => file.path));
    if (paths.size !== source.files.length) ctx.addIssue({ code: "custom", message: "Duplicate file paths" });
    if (!/\.(?:js|ts)$/.test(source.entry) && source.entry !== "index.html")
      ctx.addIssue({ code: "custom", message: "Entry must be index.html or a JavaScript or TypeScript path" });
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
/** An app has an interface when its source contains index.html; without one it only offers actions. */
export const hasInterface = (source: Pick<ArtifactSource, "files">) => source.files.some((file) => file.path === "index.html");
