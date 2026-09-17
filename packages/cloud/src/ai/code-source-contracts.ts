import { AiFileLocation, AiFileReference } from "./file-reference-contracts";
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

const CodeWriteInput = Id.extend({
  expectedRevision: z.number().int().positive(),
  entry: ArtifactPath.optional(),
  files: z.array(z.union([ArtifactFile, z.object({ path: ArtifactPath, fromFile: AiFileReference }).strict()])).min(1).max(64),
});

export const CODE_SOURCE_TOOLS = {
  code_files: {
    description: "List authorized files in one explicit chat, Project or App shared store. Returns locations, metadata and nextAfter. Use code_file_stat to obtain the opaque version before copying; does not load bytes into model context.",
    input: AiFileLocation.omit({ path: true }).extend({ after: z.string().max(500).default(""), limit: z.number().int().min(1).max(1000).default(100) }),
  },
  code_file_stat: {
    description: "Inspect one authorized file location. Returns exists plus its exact versioned reference, size and mediaType, never its bytes. App files require Use, Project files Read, chats ownership.",
    input: z.object({ file: AiFileLocation }).strict(),
  },
  code_file_copy: {
    description: "Copy one exact file version between chat, Project and App shared stores with fresh review. Source bytes never enter tool output. App destination requires Use, Project destination Write, chat destination ownership. Set expectedVersion null only for a new destination; otherwise use its version from code_file_stat. Source/version, target rights, overwrite and byte limits are rechecked. This grants no access to other files.",
    review: true,
    input: z.object({ source: AiFileReference, destination: AiFileLocation, expectedVersion: z.string().min(1).max(128).nullable() }).strict(),
  },
  code_database_export: {
    description: "Export an App database backup into the current chat as a file. Manage required. Returns the actual path/version; no backup bytes enter tool output. Never overwrites an existing file. The chat file-size/storage limits apply. This is a Studio backup operation, not access to vendor APIs.",
    input: Id.extend({ path: z.string().startsWith("/").max(240).default("/database.sqlite").describe("New chat filename; an existing path is rejected. Choose another name after a conflict.") }),
  },
  code_manage_read: {
    description: "Read an App management snapshot before deletion: title, source revision, publication, file/JSON counts, database connection and managementRevision. Manage required. Does not expose another user's credentials or database server internals.", input: Id,
  },
  code_delete: {
    description: "Permanently delete an App, all source history, publications, grants and server data with fresh review. Read code_manage_read first. Database physical cleanup is queued, not claimed finished. Cannot delete an App that changed since review.", review: true,
    input: Id.extend({ expectedManagementRevision: z.string().regex(/^[a-f0-9]{64}$/) }),
  },
  code_database_read: {
    description: "Read App database connection status, generation, dataRevision and aggregate overview. Manage required; does not create a database. These are Studio contracts, not access to the backing service API.",
    input: Id,
  },
  code_database_clear: {
    description: "Permanently clear all table rows with fresh review while preserving schema, source, files and JSON storage. Manage required. Read code_database_read first. Returns completed and clearedTables; partial failure is explicit and cannot be blindly retried.",
    review: true,
    input: Id.extend({ expectedGeneration: z.string().regex(/^[a-f0-9]{64}$/), expectedDataRevision: z.uuid() }),
  },
  code_database_reset: {
    description: "Disconnect and permanently discard an App database, including schema, with fresh review. Preserves source, publications and files/JSON storage. Next explicit connection creates an empty database; physical deletion is queued. Read code_database_read first. Never use as a routine query fix.",
    review: true,
    input: Id.extend({ expectedGeneration: z.string().regex(/^[a-f0-9]{64}$/).nullable(), expectedDataRevision: z.uuid().nullable() }),
  },
  code_storage_list: {
    description: "Inspect an App's shared files or JSON keys for administration. Manage required. Returns storageRevision, counts and a page of key/bytes/mediaType/version metadata; no file contents. Follow nextAfter.",
    input: Id.extend({ area: z.enum(["files", "kv"]), after: z.string().max(240).default(""), limit: z.number().int().min(1).max(1000).default(100) }),
  },
  code_storage_delete: {
    description: "Delete one shared file/JSON key, or clear an explicit storage area, with fresh user review. Manage required. Source, publications and database are preserved. Read code_storage_list first.",
    review: true,
    input: Id.extend({ area: z.enum(["files", "kv", "all"]), key: z.string().min(1).max(240).optional().describe("Delete this exact key; omit to clear the entire area. Not valid with area all."), expectedStorageRevision: z.number().int().positive().describe("storageRevision from code_storage_list; concurrent writes invalidate the review.") }).refine(input => input.area !== "all" || input.key === undefined, "all clears both areas and cannot select a key"),
  },
  code_access_read: {
    description: "Read an App's current grants and accessRevision before changing access. Manage required. App Use is read; Manage is admin. Skill access is separate.",
    input: Id,
  },
  code_access_change: {
    description: "Grant, change or revoke one App permission with fresh user review. Read code_access_read first. Sharing a referenced Skill is a separate operation.",
    review: true,
    input: Id.extend({
      expectedAccessRevision: z.string().regex(/^[a-f0-9]{64}$/).describe("Exact accessRevision returned by code_access_read."),
      principal: PrincipalSchema.refine(principal => principal.type !== "service_account", "Studio Apps support user, group, authenticated or public grants.").optional().describe("New user or group from core.entities.search, authenticated, or public (read/run only, no server data). Service accounts are unsupported. Supply principal OR accessId."),
      accessId: z.uuid().optional().describe("Existing grant ID from code_access_read; supply accessId OR principal."),
      permission: z.enum(["read", "admin"]).nullable().describe("read means Use, admin means Manage; null removes an existing accessId."),
    }).refine(input => Number(input.principal !== undefined) + Number(input.accessId !== undefined) === 1
      && (input.principal === undefined || input.permission !== null), "Supply principal with permission OR accessId with permission (null removes)")
      .refine(input => input.principal?.type !== "public" || input.permission === "read", "Public Apps only support read/run access"),
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
  code_unpublish: {
    description: "Withdraw the current App publication with fresh review. Use code_manage_read first. Preserves source, publication history and data; ordinary Use-level callers can no longer start this App or its actions.",
    review: true,
    input: Id.extend({ expectedPublishedVersion: z.number().int().positive() }),
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
    description: "Atomically save complete source files against expectedRevision from code_read/create. Other files stay unchanged. Returns revision and compiler diagnostics; never runs. fromFile imports one exact chat/Project/App file reference as UTF-8 source without printing bytes. File imports receive fresh review because source may be shared or published. Use code_file_stat first; source file and bundle byte limits apply.",
    review: (input: unknown) => CodeWriteInput.parse(input).files.some(file => "fromFile" in file),
    input: CodeWriteInput,
  },
  code_remove: {
    description:
      "Remove one source file, saving immediately. Source history is retained for recovery; does not delete the app. Removing an absent file is harmless. Returns diagnostics for any broken imports.",
    input: Id.extend({ path: ArtifactPath.describe("Exact relative path of the file to remove.") }),
  },
} as const;
export type CodeSourceToolName = keyof typeof CODE_SOURCE_TOOLS;
