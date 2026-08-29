import { img } from "@k2b/stdlib/browser";
import type { DateRangeValue } from "@k2b/ui";
import type { DateOverride, OpeningRule, ShiftTemplate, UpcomingSlot, Venue } from "../../../contracts";
import { DAY_MS } from "./constants";
import type { FeedbackBucket } from "./types";

const MAX_BANNER_LONGEST_SIDE = 1600;

export const timeZoneDateConfig = (timeZone: string, locale?: string) => ({ timeZone, locale, weekStartsOn: 1 as const });
export const defaultShiftRange = (): DateRangeValue => ({
  start: new Date(Date.now() + 60 * 60_000).toISOString(),
  end: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
});
export const todayDateKey = (): string => new Date().toISOString().slice(0, 10);

export const readError = async (res: Response, fallback: string): Promise<string> => {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
};

export const canWrite = (venue: Venue): boolean => venue.permission === "write" || venue.permission === "admin";
export const canAdmin = (venue: Venue): boolean => venue.permission === "admin";
export const isSlotActive = (slot: UpcomingSlot): boolean => new Date(slot.endsAt) >= new Date();
export const fmt = (iso: string, locale?: string) =>
  new Date(iso).toLocaleString(locale, { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
export const fmtTime = (iso: string, timeZone: string, locale?: string) =>
  new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", timeZone });
export const fmtDate = (iso: string, locale?: string) => new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "short" });
export const dateKey = (date: Date): string => date.toISOString().slice(0, 10);
export const withinLastDays = (isoOrDateKey: string, days: number): boolean => {
  const date = isoOrDateKey.length === 10 ? new Date(isoOrDateKey + "T12:00:00Z") : new Date(isoOrDateKey);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() >= Date.now() - (days - 1) * DAY_MS;
};
export const feedbackBucketCount = (buckets: FeedbackBucket[]): number => buckets.reduce((sum, bucket) => sum + bucket.count, 0);
export const feedbackBucketAverage = (buckets: FeedbackBucket[]): number | null => {
  const count = feedbackBucketCount(buckets);
  if (count === 0) return null;
  const weighted = buckets.reduce((sum, bucket) => sum + (bucket.averageRating ?? 0) * bucket.count, 0);
  return Math.round((weighted / count) * 10) / 10;
};
export const parseDateKey = (value: string): Date => {
  const parsed = new Date(value + "T12:00:00Z");
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};
export const sortOpeningRules = (rules: OpeningRule[]) =>
  [...rules].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
export const sortOverrides = (entries: DateOverride[]) => [...entries].sort((a, b) => a.date.localeCompare(b.date));
export const sortShiftTemplates = (templates: ShiftTemplate[]) =>
  [...templates].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
export const bannerTransform = async (file: File): Promise<string> => {
  const data = await img.create(file);
  const longest = Math.max(data.width, data.height);
  const scale = Math.min(1, MAX_BANNER_LONGEST_SIDE / longest);
  const next = scale < 1 ? await img.resize(Math.round(data.width * scale), Math.round(data.height * scale), "fill")(data) : data;
  return img.toBase64("webp", 0.85)(next);
};
