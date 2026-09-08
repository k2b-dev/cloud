import { z } from "zod";
import { ShortIdSchema } from "./contracts";

export const EVIDENCE_EXPORT_SECTIONS = ["records", "revisions", "audit", "schema", "relations", "files", "documents", "numbers"] as const;

const EvidenceExportSectionSchema = z.enum(EVIDENCE_EXPORT_SECTIONS);
export type EvidenceExportSection = z.infer<typeof EvidenceExportSectionSchema>;

export const EvidenceExportRequestSchema = z
  .object({
    tableId: ShortIdSchema.nullable().optional(),
    from: z.string().datetime({ offset: true }).nullable().optional(),
    to: z.string().datetime({ offset: true }).nullable().optional(),
    sections: z
      .array(EvidenceExportSectionSchema)
      .min(1)
      .max(EVIDENCE_EXPORT_SECTIONS.length)
      .default([...EVIDENCE_EXPORT_SECTIONS]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.sections).size !== value.sections.length) {
      ctx.addIssue({ code: "custom", path: ["sections"], message: "Evidence export sections must be unique" });
    }
    if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "End must not be before start" });
    }
  });

const EvidenceExportStatusSchema = z.enum(["queued", "running", "cancel_requested", "completed", "failed", "canceled", "expired"]);
export type EvidenceExportStatus = z.infer<typeof EvidenceExportStatusSchema>;

const EvidenceExportCountsSchema = z
  .object({
    records: z.number().int().nonnegative().optional(),
    revisions: z.number().int().nonnegative().optional(),
    audit: z.number().int().nonnegative().optional(),
    schema: z.number().int().nonnegative().optional(),
    relations: z.number().int().nonnegative().optional(),
    files: z.number().int().nonnegative().optional(),
    documents: z.number().int().nonnegative().optional(),
    numbers: z.number().int().nonnegative().optional(),
  })
  .strict();

export const EvidenceExportManifestSchema = z
  .object({
    schema: z.literal("cloud.grids.evidence-export"),
    version: z.literal(1),
    generatedAt: z.string().datetime({ offset: true }),
    request: z
      .object({
        id: ShortIdSchema,
        requestedAt: z.string().datetime({ offset: true }),
        requestedByDisplayName: z.string().nullable(),
      })
      .strict(),
    consistency: z.object({ kind: z.literal("postgres-repeatable-read"), cutAt: z.string().datetime({ offset: true }) }).strict(),
    scope: z
      .object({
        baseId: ShortIdSchema,
        tableId: ShortIdSchema.nullable(),
        from: z.string().datetime({ offset: true }).nullable(),
        to: z.string().datetime({ offset: true }).nullable(),
        sections: z.array(EvidenceExportSectionSchema),
      })
      .strict(),
    coverage: z
      .object({
        completeWithinAvailableCoverage: z.literal(true),
        history: z.array(
          z
            .object({
              tableId: ShortIdSchema,
              available: z.boolean(),
              startsAt: z.string().datetime({ offset: true }).nullable(),
              baselineComplete: z.boolean(),
            })
            .strict(),
        ),
        sources: z.array(
          z
            .object({
              section: EvidenceExportSectionSchema,
              currentAt: z.string().datetime({ offset: true }).nullable(),
              from: z.string().datetime({ offset: true }).nullable(),
              to: z.string().datetime({ offset: true }).nullable(),
              note: z.string(),
            })
            .strict(),
        ),
        note: z.string(),
      })
      .strict(),
    counts: EvidenceExportCountsSchema,
    limits: z
      .object({
        maxRowsPerPagedSource: z.number().int().positive(),
        maxEntries: z.number().int().positive(),
        maxPackageBytes: z.number().int().positive(),
        maxDurationMs: z.number().int().positive(),
      })
      .strict(),
    identity: z.string(),
    entries: z.array(
      z
        .object({
          path: z.string().min(1),
          category: z.string().min(1),
          mediaType: z.string().min(1),
          sizeBytes: z.number().int().nonnegative(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
  })
  .strict();
export type EvidenceExportManifest = z.infer<typeof EvidenceExportManifestSchema>;

export const EvidenceExportPreflightSchema = z
  .object({
    scope: z.object({ baseId: ShortIdSchema, tableId: ShortIdSchema.nullable() }).strict(),
    known: z
      .object({
        records: z.number().int().nonnegative(),
        revisions: z.number().int().nonnegative(),
        auditEvents: z.number().int().nonnegative(),
        files: z.number().int().nonnegative(),
        fileBytes: z.number().int().nonnegative(),
        documents: z.number().int().nonnegative(),
        documentEntries: z.number().int().nonnegative(),
        documentBytes: z.number().int().nonnegative(),
        numberSeries: z.number().int().nonnegative(),
        numberSeriesVersions: z.number().int().nonnegative(),
        numberAllocations: z.number().int().nonnegative(),
      })
      .strict(),
    history: z.array(
      z
        .object({
          tableId: ShortIdSchema,
          enabled: z.boolean(),
          startsAt: z.string().datetime({ offset: true }).nullable(),
          baselineComplete: z.boolean(),
        })
        .strict(),
    ),
    tables: z.array(
      z
        .object({
          tableId: ShortIdSchema,
          name: z.string(),
          trashed: z.boolean(),
          records: z.number().int().nonnegative(),
          history: z
            .object({
              state: z.enum(["unavailable", "legacy", "activating", "active", "incomplete"]),
              startsAt: z.string().datetime({ offset: true }).nullable(),
              baselineComplete: z.boolean(),
            })
            .strict(),
          finalization: z
            .object({
              enabled: z.boolean(),
              finalizedRecords: z.number().int().nonnegative(),
            })
            .strict(),
        })
        .strict(),
    ),
    withinKnownBudgets: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict();
export type EvidenceExportPreflight = z.infer<typeof EvidenceExportPreflightSchema>;

export const EvidenceExportSchema = z
  .object({
    id: ShortIdSchema,
    baseId: ShortIdSchema,
    tableId: ShortIdSchema.nullable(),
    status: EvidenceExportStatusSchema,
    sections: z.array(EvidenceExportSectionSchema),
    from: z.string().datetime({ offset: true }).nullable(),
    to: z.string().datetime({ offset: true }).nullable(),
    requestedAt: z.string().datetime({ offset: true }),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    cutAt: z.string().datetime({ offset: true }).nullable(),
    progress: z.object({ processed: z.number().int().nonnegative(), estimated: z.number().int().nonnegative().nullable() }).strict(),
    package: z
      .object({
        filename: z.string(),
        mediaType: z.literal("application/x-tar"),
        sizeBytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
        manifestVersion: z.literal(1),
      })
      .strict()
      .nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type EvidenceExport = z.infer<typeof EvidenceExportSchema>;

export const EvidenceExportListSchema = z.object({ items: z.array(EvidenceExportSchema) }).strict();
