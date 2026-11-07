import { z } from "zod";

// Export deliberately carries fewer fields than the history reader. Unknown actions fail closed.
export const ExportAction = z.enum([
  "folder.create",
  "item.rename",
  "item.move",
  "item.copy",
  "file.upload",
  "file.overwrite",
  "file.create",
  "file.edit",
  "version.comment",
  "version.restore",
  "version.restore_copy",
  "version.delete",
  "item.trash",
  "item.restore",
  "item.purge",
  "share.create",
  "share.revoke",
  "place.retire",
  "place.provision",
  "place.archive",
  "place.restore",
  "admin.read",
  "item.differs",
  "item.elsewhere",
  "item.missing",
]);
export const ACTIVITY_EXPORT_LIMIT = 100_000;
// The reader's existing candidate budget also bounds each export batch.
export const ACTIVITY_EXPORT_BATCH = 500;
export const ActivityExportInput = z
  .object({
    format: z.enum(["csv", "jsonl"]),
    from: z.iso.date(),
    to: z.iso.date(),
    baseId: z.string().min(1).max(256).optional(),
    q: z.string().trim().min(1).max(4096).optional(),
    actor: z.uuid().optional(),
    action: ExportAction.optional(),
  })
  .strict();
export type ActivityExportInput = z.infer<typeof ActivityExportInput>;

export class ActivityExportError extends Error {
  constructor(
    public readonly code: "activity_export_range" | "activity_export_limit" | "activity_export_failed",
    public readonly status: 413 | 503,
  ) {
    super(code);
  }
}

/** Inclusive UTC dates, ending before the anniversary (clamped for February 29). */
export function exportWindow(input: ActivityExportInput): { from: string; until: string } {
  const start = new Date(`${input.from}T00:00:00.000Z`);
  const end = new Date(`${input.to}T00:00:00.000Z`);
  const anniversary = new Date(start);
  anniversary.setUTCFullYear(start.getUTCFullYear() + 1);
  if (anniversary.getUTCMonth() !== start.getUTCMonth()) anniversary.setUTCDate(0);
  const until = new Date(end.getTime() + 86_400_000);
  if (end < start || until > anniversary) throw new ActivityExportError("activity_export_range", 413);
  return { from: start.toISOString(), until: until.toISOString() };
}

export const ExportRow = z.object({
  id: z.uuid(),
  action: ExportAction,
  state: z.enum(["pending", "done", "failed", "not_done", "unclear"]),
  time: z.string(),
  startedAt: z.date().transform((date) => date.toISOString()),
  finishedAt: z
    .date()
    .nullable()
    .transform((date) => date?.toISOString() ?? null),
  actorKind: z.enum(["user", "visitor", "system", "observed"]),
  actorUserId: z.uuid().nullable(),
  via: z.string(),
  directory: z.boolean().nullable(),
  rootBefore: z.string().nullable(),
  baseBeforeId: z.uuid().nullable(),
  pathBefore: z.string().nullable(),
  itemBeforeId: z.string().nullable(),
  rootAfter: z.string().nullable(),
  baseAfterId: z.uuid().nullable(),
  pathAfter: z.string().nullable(),
  itemAfterId: z.string().nullable(),
  batchId: z.uuid().nullable(),
});
export type ExportRow = z.input<typeof ExportRow>;
export const EXPORT_COLUMNS = [
  "id",
  "action",
  "state",
  "time",
  "startedAt",
  "finishedAt",
  "actorKind",
  "actorUserId",
  "actorName",
  "via",
  "directory",
  "rootBefore",
  "baseBeforeId",
  "pathBefore",
  "itemBeforeId",
  "rootAfter",
  "baseAfterId",
  "pathAfter",
  "itemAfterId",
  "batchId",
] as const;

/** Prefix before quoting: spreadsheets skip whitespace and control characters before formulas. */
export function csvCell(value: string | boolean | null): string {
  let text = value === null ? "" : String(value);
  if (/^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
