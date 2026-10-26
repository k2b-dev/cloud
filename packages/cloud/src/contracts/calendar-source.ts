import { z } from "zod";
import { type CapabilityManifest, CapabilitySemanticLinkSchema, CloudResourceRefSchema } from "./capabilities";
import { type CapabilityContract, type CapabilityContractIssue, capabilityContractIssues } from "./capability-compatibility";

/** Elapsed time, matching Spaces agenda's public 31-day request budget. */
export const CALENDAR_SOURCE_MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
/** Spaces agenda's 100-item page; providers must also fit the 256 KiB capability result budget. */
export const CALENDAR_SOURCE_PAGE_LIMIT = 100;
/** Stale writes fail with HTTP 409. Sources never overwrite a different version. */
export const CALENDAR_VERSION_CONFLICT = "CALENDAR_VERSION_CONFLICT";

// Same opaque ID/cursor and display-text budgets as file providers and capability links.
// Field bounds limit individual allocations; they do not replace the 256 KiB page budget.
const IdSchema = z.string().min(1).max(2048).describe("Opaque source identifier or version.");
const CursorSchema = z.string().min(1).max(16384).describe("Opaque continuation cursor; keep the other inputs unchanged.");
const TimestampSchema = z.string().datetime({ offset: true }).describe("Timestamp with an explicit UTC offset.");
const DateSchema = z.iso.date().describe("Date in the source configured date/time zone.");
const TimeZoneSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((zone) => {
    try {
      // Intl also accepts fixed offsets; the contract requires a named IANA zone.
      return !/^[+-]/.test(new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone);
    } catch {
      return false;
    }
  }, "Expected an IANA time zone")
  .describe("IANA time zone, or null for an instant without a display zone.");
const OpenSchema = CapabilitySemanticLinkSchema.extend({ rel: z.literal("open") }).loose();
const LimitSchema = z.number().int().min(1).max(CALENDAR_SOURCE_PAGE_LIMIT).optional().describe("Maximum page size, between 1 and 100.");

export const CalendarListInputSchema = z.object({ cursor: CursorSchema.optional(), limit: LimitSchema }).strict();
export const CalendarDescriptorSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    suggested: z.boolean(),
    visibility: z.enum(["details", "busy"]),
    writable: z.boolean(),
    open: OpenSchema.optional(),
  })
  .loose();
export const CalendarListDataSchema = z
  .object({ items: z.array(CalendarDescriptorSchema).max(CALENDAR_SOURCE_PAGE_LIMIT), next: CursorSchema.nullable() })
  .loose();

/** Half-open [from, to): events overlap it; deadlines have a due point inside it. */
export const CalendarEventsInputSchema = z
  .object({
    calendarIds: z
      .array(IdSchema)
      .min(1)
      .max(CALENDAR_SOURCE_PAGE_LIMIT)
      .describe("Readable calendar IDs to include; unknown or unreadable IDs are omitted."),
    from: TimestampSchema,
    to: TimestampSchema,
    cursor: CursorSchema.optional(),
    limit: LimitSchema,
  })
  .strict()
  .refine((input) => Date.parse(input.to) > Date.parse(input.from), "to must be after from")
  .refine((input) => Date.parse(input.to) - Date.parse(input.from) <= CALENDAR_SOURCE_MAX_RANGE_MS, "Range exceeds 31 elapsed days");

const EventDateSchema = z
  .object({ kind: z.literal("date").describe("Date-only time."), start: DateSchema, end: DateSchema })
  .loose()
  .refine((time) => time.end > time.start, "Date end must be exclusive and after start");
const EventInstantSchema = z
  .object({
    kind: z.literal("instant").describe("Time with an explicit offset."),
    start: TimestampSchema,
    end: TimestampSchema,
    timeZone: TimeZoneSchema.nullable().describe("IANA display zone, or null."),
  })
  .loose()
  .refine((time) => Date.parse(time.end) >= Date.parse(time.start), "End must not precede start");
/** Date-only values use the source's configured date/time zone; floating instants are forbidden. */
export const CalendarEventTimeSchema = z.discriminatedUnion("kind", [EventDateSchema, EventInstantSchema]);
const DueDateSchema = z.object({ kind: z.literal("date").describe("Date-only time."), date: DateSchema }).loose();
const DueInstantSchema = z
  .object({
    kind: z.literal("instant").describe("Time with an explicit offset."),
    at: TimestampSchema,
    timeZone: TimeZoneSchema.nullable().describe("IANA display zone, or null."),
  })
  .loose();
export const CalendarDueTimeSchema = z.discriminatedUnion("kind", [DueDateSchema, DueInstantSchema]);
export const CalendarOccurrenceSchema = z
  .object({
    seriesId: IdSchema,
    originalStart: z.union([TimestampSchema, DateSchema]),
    // Display only: the source expands recurrence. A 1000-character RRULE fits the capability display budget.
    rule: z.string().max(1000).nullable(),
  })
  .loose();
const identity = { id: IdSchema, calendarId: IdSchema };
const details = {
  ...identity,
  title: z.string().max(500),
  occurrence: CalendarOccurrenceSchema.nullable(),
  ref: CloudResourceRefSchema.loose().nullable(),
  open: OpenSchema.nullable(),
  version: IdSchema,
};
const eventState = { status: z.enum(["confirmed", "cancelled"]), transparency: z.enum(["busy", "free"]) };
export const CalendarItemSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("event"),
      ...details,
      time: CalendarEventTimeSchema,
      location: z.string().max(500).nullable(),
      ...eventState,
    })
    .loose(),
  z.object({ type: z.literal("deadline"), ...details, due: CalendarDueTimeSchema, done: z.boolean() }).loose(),
  z.object({ type: z.literal("busy"), ...identity, time: CalendarEventTimeSchema, ...eventState }).loose(),
]);
export const CalendarEventsDataSchema = z
  .object({ items: z.array(CalendarItemSchema).max(CALENDAR_SOURCE_PAGE_LIMIT), next: CursorSchema.nullable() })
  .loose();

const writeIdentity = {
  ...identity,
  version: IdSchema,
  scope: z.enum(["occurrence", "series"]).optional().describe("Recurring write target; the source requires a scope for recurring items."),
};
export const CalendarUpdateInputSchema = z
  .object({
    ...writeIdentity,
    changes: z
      .object({
        title: z.string().max(500).optional().describe("Replacement title."),
        location: z.string().max(500).nullable().optional().describe("Replacement location; null clears it."),
        done: z.boolean().optional().describe("Replacement deadline completion state."),
      })
      .strict()
      .describe("Fields to update; the source validates which apply to the item."),
  })
  .strict();
export const CalendarMoveInputSchema = z
  .object({
    ...writeIdentity,
    time: z
      .discriminatedUnion("kind", [EventDateSchema.strict(), EventInstantSchema.strict()])
      .optional()
      .describe("Replacement event time; mutually exclusive with due."),
    due: z
      .discriminatedUnion("kind", [DueDateSchema.strict(), DueInstantSchema.strict()])
      .optional()
      .describe("Replacement deadline due point; mutually exclusive with time."),
  })
  .strict()
  .refine((input) => (input.time === undefined) !== (input.due === undefined), "Provide exactly one of time or due");
export const CalendarDeleteInputSchema = z.object(writeIdentity).strict();
export const CalendarUpdateDataSchema = z.object({ item: CalendarItemSchema }).loose();
export const CalendarMoveDataSchema = CalendarUpdateDataSchema;
export const CalendarDeleteDataSchema = z.object({}).loose();

/** Queries have no streams and openWorld:false. Reserved writes require idempotency keys and current versions. */
export const calendarSource = {
  calendars: { kind: "query", input: CalendarListInputSchema, data: CalendarListDataSchema },
  events: { kind: "query", input: CalendarEventsInputSchema, data: CalendarEventsDataSchema },
  update: { kind: "action", idempotency: "required", input: CalendarUpdateInputSchema, data: CalendarUpdateDataSchema },
  move: { kind: "action", idempotency: "required", input: CalendarMoveInputSchema, data: CalendarMoveDataSchema },
  delete: { kind: "action", idempotency: "required", input: CalendarDeleteInputSchema, data: CalendarDeleteDataSchema },
} as const satisfies Record<string, CapabilityContract>;
export type CalendarSourceFunction = keyof typeof calendarSource;
export const CALENDAR_SOURCE_FUNCTIONS = [
  "calendars",
  "events",
  "update",
  "move",
  "delete",
] as const satisfies readonly CalendarSourceFunction[];
export type CalendarSourceIssue = CapabilityContractIssue & { function: CalendarSourceFunction; localId: string };
export const calendarSourceIssues = (manifest: CapabilityManifest): CalendarSourceIssue[] => {
  const declaration = manifest.calendarSource;
  if (!declaration) return [];
  return CALENDAR_SOURCE_FUNCTIONS.flatMap((name) => {
    const localId = declaration[name];
    if (localId === undefined) return [];
    const query = manifest.queries.find((operation) => operation.localId === localId);
    const action = manifest.actions.find((operation) => operation.localId === localId);
    const issues: CapabilityContractIssue[] = query
      ? capabilityContractIssues(calendarSource[name], { kind: "query", operation: query })
      : action
        ? capabilityContractIssues(calendarSource[name], { kind: "action", operation: action })
        : [{ code: "kind", path: "$", message: `No Query or Action named ${localId}` }];
    if ((query ?? action)?.openWorld) issues.push({ code: "kind", path: "$", message: "Calendar operations must have openWorld: false" });
    if (name === "delete" && action && !action.destructive)
      issues.push({ code: "kind", path: "$", message: "Calendar delete must be destructive" });
    return issues.map((issue) => ({ ...issue, function: name, localId }));
  });
};

export type CalendarListInput = z.output<typeof CalendarListInputSchema>;
export type CalendarDescriptor = z.output<typeof CalendarDescriptorSchema>;
export type CalendarListData = z.output<typeof CalendarListDataSchema>;
export type CalendarEventsInput = z.output<typeof CalendarEventsInputSchema>;
export type CalendarEventTime = z.output<typeof CalendarEventTimeSchema>;
export type CalendarDueTime = z.output<typeof CalendarDueTimeSchema>;
export type CalendarOccurrence = z.output<typeof CalendarOccurrenceSchema>;
export type CalendarItem = z.output<typeof CalendarItemSchema>;
export type CalendarEventsData = z.output<typeof CalendarEventsDataSchema>;
export type CalendarUpdateInput = z.output<typeof CalendarUpdateInputSchema>;
export type CalendarMoveInput = z.output<typeof CalendarMoveInputSchema>;
export type CalendarDeleteInput = z.output<typeof CalendarDeleteInputSchema>;
export type CalendarUpdateData = z.output<typeof CalendarUpdateDataSchema>;
export type CalendarMoveData = z.output<typeof CalendarMoveDataSchema>;
export type CalendarDeleteData = z.output<typeof CalendarDeleteDataSchema>;

const projectTime = (time: CalendarEventTime): CalendarEventTime =>
  time.kind === "date"
    ? { kind: "date", start: time.start, end: time.end }
    : { kind: "instant", start: time.start, end: time.end, timeZone: time.timeZone };
const projectOpen = (open: z.output<typeof OpenSchema>) => ({
  rel: open.rel,
  href: open.href,
  ...(open.title === undefined ? {} : { title: open.title }),
});
/** Readers discard every unrecognized field, including nested fields and all details on busy items. */
export const projectCalendarItem = (item: CalendarItem): CalendarItem => {
  const identity = { id: item.id, calendarId: item.calendarId };
  if (item.type === "busy")
    return { type: "busy", ...identity, time: projectTime(item.time), status: item.status, transparency: item.transparency };
  const details = {
    ...identity,
    title: item.title,
    version: item.version,
    occurrence: item.occurrence && {
      seriesId: item.occurrence.seriesId,
      originalStart: item.occurrence.originalStart,
      rule: item.occurrence.rule,
    },
    ref: item.ref && { type: item.ref.type, id: item.ref.id },
    open: item.open && projectOpen(item.open),
  };
  return item.type === "event"
    ? {
        type: "event",
        ...details,
        time: projectTime(item.time),
        location: item.location,
        status: item.status,
        transparency: item.transparency,
      }
    : {
        type: "deadline",
        ...details,
        done: item.done,
        due:
          item.due.kind === "date"
            ? { kind: "date", date: item.due.date }
            : { kind: "instant", at: item.due.at, timeZone: item.due.timeZone },
      };
};
export const projectCalendarDescriptor = (calendar: CalendarDescriptor): CalendarDescriptor => ({
  id: calendar.id,
  name: calendar.name,
  suggested: calendar.suggested,
  visibility: calendar.visibility,
  writable: calendar.writable,
  ...(calendar.description === undefined ? {} : { description: calendar.description }),
  ...(calendar.color === undefined ? {} : { color: calendar.color }),
  ...(calendar.open === undefined ? {} : { open: projectOpen(calendar.open) }),
});
