import { z } from "zod";
import { CodeResourceId } from "./browser-code-contracts";
import { PrincipalSchema } from "../contracts/shared";

// Flat Assistant tool inputs. The owning service also validates its domain contracts.
const Id = z.object({ id: CodeResourceId }).strict();
const Page = z.number().int().min(1).max(100000).default(1);
const ArtifactPath = z
  .string()
  .min(1)
  .max(180)
  .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/)
  .refine((path) => path.split("/").every((part) => part !== "." && part !== ".."));
const ArtifactFile = z
  .object({
    path: ArtifactPath,
    content: z
      .string()
      .max(1024 * 1024)
      .describe("Complete source file content; read existing content before replacing it."),
  })
  .strict();
const Icon = z
  .string()
  .regex(/^ti ti-[a-z0-9-]+$/)
  .max(80);
const ArtifactMetadata = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
    icon: Icon.optional(),
  })
  .strict();
const ArtifactCreate = ArtifactMetadata.required({ title: true });
const PublicationNote = z.string().trim().min(1).max(1000);
const DatabaseSql = z.object({
  sql: z.string().trim().min(1).max(16000).describe("Read-only SELECT; no writes, CTEs or comments. Use LIMIT."),
  params: z.array(z.json()).max(1000).default([]),
});

export const CODE_SOURCE_TOOLS = {
  code_access_read: {
    description: "Read an App's current grants and accessRevision before changing access. Manage required. App Use is read; Manage is admin. Skill access is separate.",
    input: Id,
  },
  code_access_change: {
    description: "Grant, change or revoke one App permission with fresh user review. Read code_access_read first. Sharing a referenced Skill is a separate operation.",
    review: true,
    input: Id.extend({
      expectedAccessRevision: z.string().regex(/^[a-f0-9]{64}$/).describe("Exact accessRevision returned by code_access_read."),
      principal: PrincipalSchema.refine(principal => principal.type !== "public" && principal.type !== "service_account", "Studio Apps support user, group or authenticated grants.").optional().describe("New user or group from core.entities.search, or authenticated. Studio does not support public or service_account grants. Supply principal OR accessId."),
      accessId: z.uuid().optional().describe("Existing grant ID from code_access_read; supply accessId OR principal."),
      permission: z.enum(["read", "admin"]).nullable().describe("read means Use, admin means Manage; null removes an existing accessId."),
    }).refine(input => Number(input.principal !== undefined) + Number(input.accessId !== undefined) === 1
      && (input.principal === undefined || input.permission !== null), "Supply principal with permission OR accessId with permission (null removes)"),
  },
  code_actions: {
    description: "Discover a visible App's currently published actions and their complete input/output JSON Schemas without running code. Returns publishedVersion for code_action. Requires Use; no draft source or management tools are loaded.",
    input: Id.extend({ draft: z.boolean().default(false).describe("Inspect current draft actions instead of the publication; Manage required.") }),
  },
  code_sql: {
    description:
      "Run a read-only SELECT directly against an App database without writing code. Supply its id and parameterized SQL. Does not create or connect a database. Requires current resource access; Project access applies only in that Project chat. Narrow columns and add LIMIT for large results.",
    input: Id.extend(DatabaseSql.shape),
  },
  code_versions: {
    description: "List numbered published versions with notes, author and date. Admin only. Separate from automatic file-save history.",
    input: Id.extend({ page: Page }),
  },
  code_list: {
    description:
      "Find accessible Apps, including published Project Apps in the current authorized Project chat. Reuse the intended resource instead of creating duplicates.",
    input: z
      .object({
        page: Page,
        q: z.string().max(120).optional().describe("Find by title or description; matches only metadata you may access."),
      })
      .strict(),
  },
  code_read: {
    description:
      "Read the current file, or omit path for the directory. Follow nextOffset for long files. revision is optional and only needed to inspect history.",
    input: Id.extend({
      path: ArtifactPath.optional().describe("Exact relative file path. Omit to list files."),
      offset: z.number().int().min(0).default(0).describe("UTF-16 offset; follow nextOffset for the remaining content."),
      revision: z.number().int().positive().optional().describe("Historical revision from code_history. Omit for current files."),
    }),
  },
  code_history: {
    description: "List previous saved versions. Use code_read with a returned revision only when historical source is needed.",
    input: Id.extend({ page: Page }),
  },
  code_fork: {
    description:
      "Create a private editable copy of an accessible publication. Source is copied; shared data, database and Project associations are not. Project-only access does not permit forks.",
    input: Id,
  },
  code_publish: {
    description:
      "Publish tested working source as the next numbered version. A concise change note is required. Never changes sharing. Read current revision first; a concurrent edit causes a conflict.",
    input: Id.extend({
      expectedRevision: z
        .number()
        .int()
        .positive()
        .describe("Current working revision from code_read; prevents conflicting publication or restore."),
      note: PublicationNote,
    }),
  },
  code_restore: {
    description:
      "Restore a published version including title, description and icon as the working source and a new latest publication, atomically. Automatically records Restore version X. Preserves publication history and user data; do not call code_publish again.",
    input: Id.extend({
      version: z.number().int().positive().describe("Publication number returned by code_versions."),
      expectedRevision: z
        .number()
        .int()
        .positive()
        .describe("Current working revision from code_read; prevents conflicting publication or restore."),
    }),
  },
  code_update: {
    description: "Change working title, description or Tabler icon. Does not publish. Use e.g. ti ti-calculator or ti ti-chart-bar.",
    input: Id.extend(ArtifactMetadata.shape),
  },
  code_create: {
    description:
      "Create a private reusable App with an optional UI, published actions and optional persistence. For one-off analysis, use code_run with code instead. Returns id and entry path; write source with code_write. Optional icon uses the complete class, e.g. ti ti-chart-bar; omit it when unsure. Does not run or share anything.",
    input: ArtifactCreate.pick({ title: true, description: true, icon: true }),
  },
  code_write: {
    description:
      "Atomically save a batch of source/data files against expectedRevision from code_read/create. Other files stay unchanged. Returns the new revision and compiler diagnostics; never runs. Use fromChatFile with exact path and version to copy data without putting its contents in the model response. Import .json as data or .csv/.txt as text.",
    input: Id.extend({
      expectedRevision: z.number().int().positive(),
      entry: ArtifactPath.optional(),
      files: z.array(z.union([ArtifactFile, z.object({
        path: ArtifactPath,
        fromChatFile: z.object({ path: z.string().startsWith("/"), version: z.number().int().positive() }).strict(),
      }).strict()])).min(1).max(64),
    }),
  },
  code_remove: {
    description:
      "Remove one source file, saving immediately. Source history is retained for recovery; does not delete the app. Removing an absent file is harmless. Returns diagnostics for any broken imports.",
    input: Id.extend({ path: ArtifactPath.describe("Exact relative path of the file to remove.") }),
  },
} as const;
export type CodeSourceToolName = keyof typeof CODE_SOURCE_TOOLS;
