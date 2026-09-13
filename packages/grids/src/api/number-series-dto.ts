import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import type { NumberSeriesSummary } from "../service/number-series";

export const PublicNumberSeriesSummarySchema = z
  .object({
    id: ShortIdSchema,
    assignment: z.enum(["creation", "finalization"]),
    state: z.enum(["active", "archived"]),
    currentVersion: z.number().int().positive(),
    lastValue: z.number().int().nonnegative(),
    preview: z.string().nullable(),
  })
  .strict();

export const toPublicNumberSeries = (series: NumberSeriesSummary) =>
  PublicNumberSeriesSummarySchema.parse({
    id: series.shortId,
    assignment: series.assignment,
    state: series.state,
    currentVersion: series.currentVersion,
    lastValue: series.lastValue,
    preview: series.preview,
  });
