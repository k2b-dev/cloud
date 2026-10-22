import { dates } from "@k2b/stdlib";
import { z } from "zod";

export const SourceExpectationSchema = z
  .object({
    expectEverySeconds: z.number().int().positive().max(2_147_483_647).nullable(),
    expectDailyBy: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable(),
  })
  .refine((value) => value.expectEverySeconds === null || value.expectDailyBy === null, {
    message: "Choose either an interval or a daily expectation",
    path: ["expectDailyBy"],
  });
export type SourceExpectation = z.infer<typeof SourceExpectationSchema>;
export type FreshnessSource = SourceExpectation & {
  kind: "metrics" | "http_ingest";
  enabled: boolean;
  deleted?: boolean;
  scrapeIntervalSeconds: number | null;
  newestDataAt: string | null;
  createdAt: string;
};
const previousDate = (day: string) => {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
};

/** Reads only control metadata. A contact/accepted timestamp cannot make data fresh. */
export const sourceStaleSince = (source: FreshnessSource, timezone: string, now: Date): string | null => {
  if (!source.enabled || source.deleted) return null;
  const interval = source.kind === "metrics" ? (source.scrapeIntervalSeconds ?? 0) * 3 : source.expectEverySeconds;
  if (interval && interval > 0) {
    const deadline = Date.parse(source.newestDataAt ?? source.createdAt) + interval * 1000;
    return now.getTime() >= deadline ? new Date(deadline).toISOString() : null;
  }
  if (source.kind !== "http_ingest" || !source.expectDailyBy) return null;
  // A repeated wall time uses its later occurrence; a missing time moves forward
  // by the DST gap. This never declares a daily delivery late in the first fold.
  const deadlineFor = (day: string) =>
    Date.parse(dates.zonedDateTimeToInstant(`${day}T${source.expectDailyBy}`, timezone, { disambiguation: "later" }));
  let day = dates.instantToZonedInput(now, timezone).slice(0, 10);
  if (deadlineFor(day) > now.getTime()) day = previousDate(day);
  const deadline = deadlineFor(day);
  // A source created after the latest deadline gets its first complete window.
  if (Date.parse(source.createdAt) >= deadline) return null;
  const previousDeadline = deadlineFor(previousDate(day));
  return source.newestDataAt !== null && Date.parse(source.newestDataAt) > previousDeadline ? null : new Date(deadline).toISOString();
};
