import { createHash } from "node:crypto";
import {
  CALENDAR_SOURCE_PAGE_LIMIT,
  CAPABILITY_MAX_RESULT_BYTES,
  CalendarEventsDataSchema,
  type CalendarEventsInput,
  CalendarEventsInputSchema,
  type CalendarListInput,
  CalendarListInputSchema,
  type CalendarItem as SourceItem,
} from "@k2b/cloud/contracts";
import type { AccessSubject } from "@k2b/cloud/server";
import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { type DateContext, dates } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import type { CalendarItem } from "../contracts";
import { buildSpaceItemHref } from "../routes";
import { buildSpacePrincipalCondition } from "./access";
import { listCalendar } from "./items";
import { projectCalendarItems, projectSpaces } from "./public-resources";
import { MAX_OCCURRENCE_LOOKUP_STEPS } from "./recurrence";
import { listPage } from "./spaces";

type SourceContext = { subject: AccessSubject; boundSpaceId?: string | null; dateConfig: DateContext };
export class CalendarSourceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const CursorSchema = z
  .object({ scope: z.string().length(64), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
  .strict();
const decode = (cursor: string | undefined, scope: string) => {
  if (!cursor) return 0;
  try {
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (parsed.scope !== scope) throw new Error();
    return parsed.offset;
  } catch {
    throw new CalendarSourceError("CALENDAR_INVALID_CURSOR");
  }
};
const encode = (offset: number, scope: string) => Buffer.from(JSON.stringify({ offset, scope })).toString("base64url");

export const listSourceCalendars = async (raw: CalendarListInput, context: SourceContext) => {
  const input = CalendarListInputSchema.parse(raw);
  const limit = input.limit ?? CALENDAR_SOURCE_PAGE_LIMIT;
  const scope = hash({ subject: context.subject, boundSpaceId: context.boundSpaceId, limit });
  const offset = decode(input.cursor, scope);
  if (offset % limit) throw new CalendarSourceError("CALENDAR_INVALID_CURSOR");
  const page = await listPage({ ...context, pagination: { page: offset / limit + 1, perPage: limit } });
  const publicSpaces = await projectSpaces(page.items);
  // A member has a person/account/group grant. Public and authenticated-only grants make a Space readable, not suggested.
  const internalIds = page.items.map((space) => space.id);
  const membership = internalIds.length
    ? await sql<{ space_id: string }[]>`
    SELECT DISTINCT sa.space_id FROM spaces.space_access sa JOIN auth.access a ON a.id = sa.access_id
    WHERE sa.space_id = ANY(${toPgUuidArray(internalIds)}::uuid[]) AND a.permission <> 'none'
      AND ${buildSpacePrincipalCondition(context.subject)}
      AND (a.user_id IS NOT NULL OR a.group_id IS NOT NULL OR a.service_account_id IS NOT NULL)
  `
    : [];
  const members = new Set(membership.map((row) => row.space_id));
  return {
    items: publicSpaces.map((space, index) => ({
      id: space.id,
      name: space.name.slice(0, 200),
      ...(space.description ? { description: space.description.slice(0, 500) } : {}),
      ...(/^#[0-9a-fA-F]{6}$/.test(space.color) ? { color: space.color } : {}),
      suggested: members.has(page.items[index]!.id),
      visibility: "details" as const,
      writable: false,
      open: { rel: "open" as const, href: `/app/spaces/${space.id}?view=calendar` },
    })),
    next: page.hasNext ? encode(offset + publicSpaces.length, scope) : null,
  };
};

const nextDay = (key: string) => new Date(Date.parse(`${key}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** The old calendar stores all-day ends at 23:59:59.999; imported events may use exclusive midnight. */
const eventTime = (item: CalendarItem, dateConfig: DateContext) => {
  if (!item.startsAt || !item.endsAt) throw new CalendarSourceError("CALENDAR_AMBIGUOUS_TIME");
  if (!item.allDay) return { kind: "instant" as const, start: item.startsAt, end: item.endsAt, timeZone: dateConfig.timeZone ?? "UTC" };
  const start = dates.formatDateKey(item.startsAt, dateConfig);
  const endKey = dates.formatDateKey(item.endsAt, dateConfig);
  const atMidnight = dates.startOfDay(item.endsAt, dateConfig).getTime() === Date.parse(item.endsAt);
  return { kind: "date" as const, start, end: atMidnight && endKey > start ? endKey : nextDay(endKey) };
};
export const projectSourceItem = (item: CalendarItem, version: string, rule: string | null, dateConfig: DateContext): SourceItem => {
  const seriesId = item.recurringEventId;
  const originalStart = item.recurrenceId;
  if ((seriesId && !originalStart) || (!seriesId && originalStart)) throw new CalendarSourceError("CALENDAR_AMBIGUOUS_RECURRENCE");
  const itemId = seriesId ?? item.id;
  // RRULE is display-only. A valid legacy rule beyond the contract's display budget still expands normally.
  const recurrence =
    seriesId && originalStart ? { seriesId, originalStart, rule: rule !== null && rule.length > 1000 ? null : rule } : null;
  const facts = {
    id: recurrence ? `${seriesId}:${originalStart}` : item.id,
    calendarId: item.spaceId,
    title: item.title.slice(0, 500),
    occurrence: recurrence,
    ref: { type: "spaces.item", id: itemId },
    open: {
      rel: "open" as const,
      href: `${buildSpaceItemHref(item.spaceId, itemId)}${originalStart ? `&occurrence=${encodeURIComponent(originalStart)}` : ""}`,
    },
    version,
  };
  if (item.startsAt && item.endsAt)
    return {
      type: "event",
      ...facts,
      time: eventTime(item, dateConfig),
      location: item.location?.slice(0, 500) ?? null,
      status: "confirmed",
      transparency: "busy",
    };
  if (!item.deadline) throw new CalendarSourceError("CALENDAR_AMBIGUOUS_TIME");
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(item.deadline);
  return {
    type: "deadline",
    ...facts,
    done: false,
    due:
      dateOnly || item.deadlineAllDay
        ? { kind: "date", date: dateOnly ? item.deadline : dates.formatDateKey(item.deadline, dateConfig) }
        : { kind: "instant", at: item.deadline, timeZone: dateConfig.timeZone ?? "UTC" },
  };
};

/** Reuse the current calendar's open-item set and recurrence expansion, with its existing complete-read guard. */
export const readSourceEvents = async (raw: CalendarEventsInput, context: SourceContext) => {
  const input = CalendarEventsInputSchema.parse(raw);
  const ids = [...new Set(input.calendarIds)].sort();
  const limit = input.limit ?? CALENDAR_SOURCE_PAGE_LIMIT;
  const scope = hash({
    ids,
    from: input.from,
    to: input.to,
    limit,
    subject: context.subject,
    boundSpaceId: context.boundSpaceId,
    dateConfig: context.dateConfig,
  });
  let after: { at: number; id: string } | undefined;
  if (input.cursor) {
    try {
      const cursor = z
        .object({ scope: z.string(), after: z.object({ at: z.number().finite(), id: z.string() }).strict() })
        .strict()
        .parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
      if (cursor.scope !== scope) throw new Error();
      after = cursor.after;
    } catch {
      throw new CalendarSourceError("CALENDAR_INVALID_CURSOR");
    }
  }
  const known = await sql<{ id: string }[]>`SELECT id FROM spaces.spaces WHERE short_id = ANY(${toPgTextArray(ids)}::text[])`;
  const internal = known.map((space) => space.id);
  if (!internal.length) return { items: [], next: null };
  const loaded = await listCalendar({
    ...context,
    sourceSpaceIds: internal,
    from: input.from,
    to: input.to,
    sourceLimit: MAX_OCCURRENCE_LOOKUP_STEPS,
  });
  const point = (value: string) =>
    Date.parse(
      /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? dates.zonedDateTimeToInstant(`${value}T00:00`, context.dateConfig.timeZone ?? "UTC", { disambiguation: "compatible" })
        : value,
    );
  const stableId = (item: CalendarItem) =>
    item.recurringEventId && item.recurrenceId ? `${item.recurringEventId}:${item.recurrenceId}` : item.id;
  const start = (item: CalendarItem) => point(item.startsAt ?? item.deadline!);
  const belongs = (item: CalendarItem) => {
    if (item.startsAt && item.endsAt) {
      const time = eventTime(item, context.dateConfig);
      const begin = point(time.start);
      const end = point(time.end);
      return begin === end
        ? begin >= Date.parse(input.from) && begin < Date.parse(input.to)
        : begin < Date.parse(input.to) && end > Date.parse(input.from);
    }
    if (!item.deadline) return false;
    const due = point(item.deadline);
    return due >= Date.parse(input.from) && due < Date.parse(input.to);
  };
  const rows = loaded
    .filter(belongs)
    .sort((a, b) => start(a) - start(b) || stableId(a).localeCompare(stableId(b)))
    .filter((item) => !after || start(item) > after.at || (start(item) === after.at && stableId(item).localeCompare(after.id) > 0));
  const chosen = rows.slice(0, limit);
  const items = await projectCalendarItems(chosen);
  const roots = [...new Set(chosen.flatMap((item) => [item.recurringEventId ?? item.id.split(":", 1)[0]!, item.id.split(":", 1)[0]!]))];
  const metadata = roots.length
    ? await sql<{ id: string; short_id: string; updated_at: Date; recurrence_rrule: string | null }[]>`
    SELECT id, short_id, updated_at, recurrence_rrule FROM spaces.items WHERE id = ANY(${toPgUuidArray(roots)}::uuid[])
  `
    : [];
  const byRoot = new Map(metadata.map((row) => [row.short_id, row]));
  const data = items.map((item) => {
    const root = byRoot.get(item.recurringEventId ?? item.id.split(":", 1)[0]!);
    return projectSourceItem(
      item,
      hash({ item, updatedAt: root?.updated_at, itemUpdatedAt: byRoot.get(item.id.split(":", 1)[0]!)?.updated_at }),
      root?.recurrence_rrule ?? null,
      context.dateConfig,
    );
  });
  const next = (count: number) =>
    count < rows.length && count > 0
      ? Buffer.from(JSON.stringify({ scope, after: { at: start(chosen[count - 1]!), id: stableId(chosen[count - 1]!) } })).toString(
          "base64url",
        )
      : null;
  const result = { items: data, next: next(data.length) };
  // Account for the normal capability envelope too, not just data.
  while (Buffer.byteLength(JSON.stringify({ ok: true, data: result }), "utf8") > CAPABILITY_MAX_RESULT_BYTES) {
    if (result.items.length <= 1) throw new CalendarSourceError("CALENDAR_ITEM_TOO_LARGE");
    result.items.pop();
    result.next = next(result.items.length);
  }
  return CalendarEventsDataSchema.parse(result);
};
