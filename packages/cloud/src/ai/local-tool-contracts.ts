import { z } from "zod";
import { AI_SKILL_DESCRIPTION_MAX_CHARS, AI_SKILL_INSTRUCTIONS_MAX_CHARS, AI_SKILL_NAME_PATTERN } from "./skill-format";

/**
 * Contracts of the client tools a local client such as `cld` runs on the user's computer, and of the context it
 * sends with a turn. Cloud declares and validates them; the client executes them and enforces its own path rules.
 */
export const AI_LOCAL_TOOL_NAMES = [
  "local_list",
  "local_read",
  "local_upload",
  "local_download",
  "local_write",
  "local_move",
  "load_local_skill",
] as const;
export type AiLocalToolName = (typeof AI_LOCAL_TOOL_NAMES)[number];

/** Longest absolute path a client reports, Linux PATH_MAX. */
export const AI_LOCAL_PATH_MAX_CHARS = 4096;
/** Entries per local_list page by default and at most, like code_files. */
export const AI_LOCAL_LIST_DEFAULT_LIMIT = 100;
export const AI_LOCAL_LIST_MAX_LIMIT = 1000;
/** Bytes per local_read call by default and at most, like read_file. */
export const AI_LOCAL_READ_DEFAULT_BYTES = 16 * 1024;
export const AI_LOCAL_READ_MAX_BYTES = 64 * 1024;
/** Text one local_write call writes, like write_file. */
export const AI_LOCAL_WRITE_MAX_BYTES = 100 * 1024;
/** Paths per upload or move batch, like the code-mode input paths and the 64-item request limits. */
export const AI_LOCAL_BATCH_MAX_ITEMS = 64;
/** AGENTS.md text one turn carries, the Codex default. */
export const AI_LOCAL_INSTRUCTIONS_MAX_BYTES = 32 * 1024;
/** Local Skills one turn lists, like the 64-item request limits. */
export const AI_LOCAL_SKILLS_MAX_ITEMS = 64;
/** Local Skills one message selects explicitly. */
export const AI_LOCAL_SELECTED_SKILLS_MAX_ITEMS = 4;
/** Files a loaded local Skill lists, like Cloud Skill references. */
export const AI_LOCAL_SKILL_FILES_MAX_ITEMS = 50;

const LocalPath = z.string().trim().min(1).max(AI_LOCAL_PATH_MAX_CHARS);
const ChatPath = z.string().trim().min(1).max(500);
const SkillName = z.string().regex(AI_SKILL_NAME_PATTERN).max(64);
/** One line of client-reported text: control characters and line breaks never reach the prompt. */
const FactLine = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim())
    .pipe(z.string().min(1));

/** A request the client did not run: the person said no, a rule refused it, or it failed. */
const LocalToolProblem = z.object({
  status: z.enum(["denied", "failed"]),
  error: z.string().max(2000),
});

export const CloudAiLocalListInputSchema = z.object({
  path: LocalPath.default(".").describe("Folder to list, relative to the workspace."),
  pattern: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe("Glob such as **/*.pdf or 2026-09/*.{pdf,jpg}; matching ignores case. ** lists subfolders."),
  recursive: z.boolean().default(false),
  limit: z.number().int().min(1).max(AI_LOCAL_LIST_MAX_LIMIT).default(AI_LOCAL_LIST_DEFAULT_LIMIT),
  after: LocalPath.optional().describe("nextAfter of the previous page."),
});
export const CloudAiLocalListOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    path: LocalPath,
    entries: z
      .array(
        z.object({
          path: LocalPath,
          type: z.enum(["file", "directory", "other"]),
          size: z.number().int().min(0),
          modifiedAt: z.string().max(40),
        }),
      )
      .max(AI_LOCAL_LIST_MAX_LIMIT),
    nextAfter: LocalPath.nullable(),
  }),
  LocalToolProblem,
]);

export const CloudAiLocalReadInputSchema = z.object({
  path: LocalPath,
  offset: z.number().int().min(1).default(1).describe("First line to read."),
  maxBytes: z.number().int().min(1).max(AI_LOCAL_READ_MAX_BYTES).default(AI_LOCAL_READ_DEFAULT_BYTES),
});
// Two completed shapes share their status, so this is a plain union rather than one keyed by status.
export const CloudAiLocalReadOutputSchema = z.union([
  z.object({
    status: z.literal("completed"),
    kind: z.literal("text"),
    path: LocalPath,
    /** Lines prefixed with their number and a tab; short lines can make the numbers outweigh the text. */
    content: z.string().max(AI_LOCAL_READ_MAX_BYTES * 10),
    firstLine: z.number().int().min(1),
    lastLine: z.number().int().min(0),
    totalBytes: z.number().int().min(0),
    nextOffset: z.number().int().min(1).nullable(),
  }),
  z.object({
    status: z.literal("completed"),
    kind: z.literal("uploaded"),
    path: LocalPath,
    chatPath: ChatPath,
    mediaType: z.string().max(120),
    size: z.number().int().min(0),
  }),
  LocalToolProblem,
]);

export const CloudAiLocalUploadInputSchema = z.object({
  paths: z.array(LocalPath).min(1).max(AI_LOCAL_BATCH_MAX_ITEMS),
  directory: ChatPath.optional().describe("Chat folder for all files; by default each file keeps its folder from the workspace."),
});
export const CloudAiLocalUploadOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    files: z
      .array(z.object({ path: LocalPath, chatPath: ChatPath, mediaType: z.string().max(120), size: z.number().int().min(0) }))
      .max(AI_LOCAL_BATCH_MAX_ITEMS),
    failed: z.array(z.object({ path: LocalPath, error: z.string().max(2000) })).max(AI_LOCAL_BATCH_MAX_ITEMS),
  }),
  LocalToolProblem,
]);

export const CloudAiLocalDownloadInputSchema = z.object({
  path: ChatPath.describe("Chat file to save."),
  to: LocalPath.describe("Target file, relative to the workspace."),
  replace: z.boolean().default(false),
});
export const CloudAiLocalDownloadOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), path: LocalPath, size: z.number().int().min(0), replaced: z.boolean() }),
  LocalToolProblem,
]);

export const CloudAiLocalWriteInputSchema = z.object({
  path: LocalPath,
  content: z.string().refine((value) => new TextEncoder().encode(value).byteLength <= AI_LOCAL_WRITE_MAX_BYTES, "Content exceeds 100 KiB."),
  mode: z.enum(["create", "append", "replace"]).default("create"),
});
export const CloudAiLocalWriteOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    path: LocalPath,
    mode: z.enum(["create", "append", "replace"]),
    size: z.number().int().min(0),
  }),
  LocalToolProblem,
]);

const LocalMove = z.object({ from: LocalPath, to: LocalPath });
export const CloudAiLocalMoveInputSchema = z.object({
  moves: z.array(LocalMove).min(1).max(AI_LOCAL_BATCH_MAX_ITEMS),
});
/** A move batch reports what already moved even when it stops, so the model can name or undo it. */
export const CloudAiLocalMoveOutputSchema = z.object({
  status: z.enum(["completed", "denied", "failed"]),
  moved: z.array(LocalMove).max(AI_LOCAL_BATCH_MAX_ITEMS),
  conflicts: z.array(z.object({ to: LocalPath, reason: z.string().max(500) })).max(AI_LOCAL_BATCH_MAX_ITEMS),
  error: z.string().max(2000).optional(),
});

export const CloudAiLoadLocalSkillInputSchema = z.object({ name: SkillName });
export const CloudAiLoadLocalSkillOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    name: SkillName,
    directory: LocalPath,
    instructions: z.string().max(AI_SKILL_INSTRUCTIONS_MAX_CHARS),
    files: z.array(LocalPath).max(AI_LOCAL_SKILL_FILES_MAX_ITEMS),
  }),
  LocalToolProblem,
]);

/** Facts about the local client a turn comes from; Cloud renders them into the "# Local client" prompt section. */
export const AiLocalClientSchema = z.object({
  kind: z.enum(["cli", "acp"]),
  /** The editor's ACP clientInfo.name. */
  name: FactLine(120).optional(),
  cwd: FactLine(AI_LOCAL_PATH_MAX_CHARS),
  os: FactLine(120),
  shell: FactLine(120),
  localTools: z.enum(["ask", "off"]),
});

/** AGENTS.md files and local Skills the client found in its workspace for one turn. */
export const AiLocalContextSchema = z.object({
  instructions: z
    .array(z.object({ path: LocalPath, content: z.string() }))
    .max(64)
    .refine(
      (files) =>
        files.reduce((bytes, file) => bytes + new TextEncoder().encode(file.content).byteLength, 0) <= AI_LOCAL_INSTRUCTIONS_MAX_BYTES,
      "AGENTS.md content exceeds 32 KiB.",
    )
    .default([]),
  skills: z
    .array(
      z.object({
        name: SkillName,
        description: z.string().trim().min(1).max(AI_SKILL_DESCRIPTION_MAX_CHARS),
        scope: z.enum(["project", "global"]),
      }),
    )
    .max(AI_LOCAL_SKILLS_MAX_ITEMS)
    .refine((skills) => new Set(skills.map((skill) => skill.name)).size === skills.length, "Local Skill names must be unique.")
    .default([]),
  selectedSkills: z
    .array(
      z.object({
        name: SkillName,
        directory: LocalPath,
        instructions: z.string().trim().min(1).max(AI_SKILL_INSTRUCTIONS_MAX_CHARS),
      }),
    )
    .max(AI_LOCAL_SELECTED_SKILLS_MAX_ITEMS)
    .default([]),
});

export type CloudAiLocalListInput = z.infer<typeof CloudAiLocalListInputSchema>;
export type CloudAiLocalListOutput = z.infer<typeof CloudAiLocalListOutputSchema>;
export type CloudAiLocalReadInput = z.infer<typeof CloudAiLocalReadInputSchema>;
export type CloudAiLocalReadOutput = z.infer<typeof CloudAiLocalReadOutputSchema>;
export type CloudAiLocalUploadInput = z.infer<typeof CloudAiLocalUploadInputSchema>;
export type CloudAiLocalUploadOutput = z.infer<typeof CloudAiLocalUploadOutputSchema>;
export type CloudAiLocalDownloadInput = z.infer<typeof CloudAiLocalDownloadInputSchema>;
export type CloudAiLocalDownloadOutput = z.infer<typeof CloudAiLocalDownloadOutputSchema>;
export type CloudAiLocalWriteInput = z.infer<typeof CloudAiLocalWriteInputSchema>;
export type CloudAiLocalWriteOutput = z.infer<typeof CloudAiLocalWriteOutputSchema>;
export type CloudAiLocalMoveInput = z.infer<typeof CloudAiLocalMoveInputSchema>;
export type CloudAiLocalMoveOutput = z.infer<typeof CloudAiLocalMoveOutputSchema>;
export type CloudAiLoadLocalSkillInput = z.infer<typeof CloudAiLoadLocalSkillInputSchema>;
export type CloudAiLoadLocalSkillOutput = z.infer<typeof CloudAiLoadLocalSkillOutputSchema>;
export type AiLocalClient = z.infer<typeof AiLocalClientSchema>;
export type AiLocalContext = z.infer<typeof AiLocalContextSchema>;
