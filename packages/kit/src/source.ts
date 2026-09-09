import { z } from "zod";
import { FilePath, LIMITS, PublicId, type Bundle, type ProjectInput } from "./contracts";
import { validateProject, ProjectValidationError } from "./project";

export const Revision = z.number().int().positive().describe("Exact app revision returned by kit.app.read; never guess or increment it.");
export const AppId = PublicId.describe("Six-character public ID from a kit.app reference or Kit app URL.");
// 16k UTF-16 units fit below 256 KiB even with worst-case JSON escaping.
export const SOURCE_WINDOW = 16000;
export const SourceReadInput = z
  .object({
    id: AppId,
    path: FilePath.describe("Exact file path returned by kit.app.read."),
    expectedRevision: Revision,
    offset: z
      .number()
      .int()
      .min(0)
      .max(LIMITS.fileBytes)
      .default(0)
      .describe("UTF-16 offset, initially zero; continue with nextOffset until complete."),
  })
  .strict();
export const SourceChanges = z
  .object({
    expectedRevision: Revision,
    upsert: z
      .array(
        z
          .object({
            path: FilePath.describe("Relative .js path to create or replace in full."),
            content: z
              .string()
              .max(LIMITS.fileBytes)
              .describe("Complete JavaScript source for this file. Read the complete old file before replacing it."),
          })
          .strict(),
      )
      .max(LIMITS.files)
      .default([])
      .describe("Complete file replacements or additions; omitted files are preserved."),
    delete: z.array(FilePath).max(LIMITS.files).default([]).describe("Exact paths to delete. Update imports in the same batch."),
    edits: z
      .array(
        z
          .object({
            path: FilePath.describe("Existing file to edit without replacing unseen content."),
            offset: z.number().int().min(0).max(LIMITS.fileBytes).describe("UTF-16 offset in the exact expectedRevision source."),
            deleteCount: z.number().int().min(0).max(LIMITS.fileBytes).describe("Number of UTF-16 units to replace; zero inserts."),
            content: z.string().max(LIMITS.fileBytes).describe("JavaScript text to insert. Use bounded edits for large files."),
          })
          .strict(),
      )
      .max(LIMITS.files)
      .default([])
      .describe("At most one range edit per file; each path appears in exactly one operation."),
  })
  .strict();
export const SourceChangeInput = SourceChanges.extend({ id: AppId });
export const MetadataInput = z
  .object({
    expectedRevision: Revision,
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(1000).optional(),
    persistenceEnabled: z.boolean().optional(),
  })
  .strict();
export type SourceChanges = z.infer<typeof SourceChanges>;

export function mergeSource(project: ProjectInput, input: SourceChanges) {
  const changes = SourceChanges.parse(input);
  const touched = [...changes.upsert.map((f) => f.path), ...changes.delete, ...changes.edits.map((f) => f.path)];
  if (!touched.length) throw new ProjectValidationError("input");
  if (new Set(touched).size !== touched.length) throw new ProjectValidationError("duplicate");
  const files = new Map(project.files.map((file) => [file.path, file.content]));
  for (const path of changes.delete) {
    if (!files.delete(path)) throw new ProjectValidationError("missing", "", path);
  }
  for (const edit of changes.edits) {
    const source = files.get(edit.path);
    if (source === undefined) throw new ProjectValidationError("missing", "", edit.path);
    if (edit.offset + edit.deleteCount > source.length) throw new ProjectValidationError("input", "", edit.path);
    files.set(edit.path, source.slice(0, edit.offset) + edit.content + source.slice(edit.offset + edit.deleteCount));
  }
  for (const file of changes.upsert) files.set(file.path, file.content);
  return validateProject({
    name: project.name,
    description: project.description,
    persistenceEnabled: project.persistenceEnabled,
    files: [...files].map(([path, content]) => ({ path, content })),
  });
}

export function sourceManifest(bundle: Bundle) {
  const { files, ...metadata } = bundle;
  return {
    ...metadata,
    files: files.map((file) => ({
      path: file.path,
      length: file.content.length,
      bytes: new TextEncoder().encode(file.content).byteLength,
    })),
  };
}
