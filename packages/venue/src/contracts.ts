import { z } from "zod";

const WeekdaySchema = z.number().int().min(0).max(6);
/** A venue clock time; `24:00` is midnight at the end of the day, so it only works as an end time. */
const TimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Expected HH:MM from 00:00 to 24:00");
const DateKeySchema = z.iso.date();
const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color must be a #RRGGBB hex value");
export const VenueResourceIdSchema = z.string().regex(/^[0-9A-Za-z]{6}$/, "Expected a 6-character Venue resource ID");

const VenueOpenModeSchema = z.enum(["regular", "staffed", "combined"]);
const VenueSignupModeSchema = z.enum(["templates", "free", "both"]);

export const VenueSchema = z.object({
  id: VenueResourceIdSchema,
  slug: z.string(),
  name: z.string(),
  icon: z.string(),
  description: z.string().nullable(),
  timezone: z.string(),
  openMode: VenueOpenModeSchema,
  signupMode: VenueSignupModeSchema,
  publicEnabled: z.boolean(),
  feedbackEnabled: z.boolean(),
  accentColor: HexColorSchema,
  logoBase64: z.string().nullable(),
  bannerBase64: z.string().nullable(),
  icalToken: z.string(),
  permission: z.enum(["none", "read", "write", "admin"]).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Venue = z.infer<typeof VenueSchema>;

/** A venue slug: 2 to 80 lowercase letters or digits, with single dashes between them. */
export const VENUE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const VENUE_SLUG_MIN_LENGTH = 2;
export const VENUE_SLUG_MAX_LENGTH = 80;
const VenueSlugSchema = z
  .string()
  .trim()
  .min(VENUE_SLUG_MIN_LENGTH)
  .max(VENUE_SLUG_MAX_LENGTH)
  .regex(VENUE_SLUG_PATTERN, "Use lowercase letters, numbers, and dashes");

/** Whether the runtime knows the IANA time zone; every venue time is computed in it. */
export const isKnownTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export const VenueInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  icon: z.string().trim().min(1).max(120).default("ti ti-building-carousel"),
  slug: VenueSlugSchema,
  description: z.string().trim().max(1_000).nullable().optional(),
  timezone: z.string().trim().min(1).max(80).refine(isKnownTimeZone, "Unknown time zone").default("Europe/Berlin"),
  openMode: VenueOpenModeSchema.default("combined"),
  signupMode: VenueSignupModeSchema.default("both"),
  publicEnabled: z.boolean().default(true),
  feedbackEnabled: z.boolean().default(true),
  accentColor: HexColorSchema.default("#2563eb"),
  logoBase64: z.string().max(2_000_000).nullable().optional(),
  bannerBase64: z.string().max(5_000_000).nullable().optional(),
});
export type VenueInput = z.infer<typeof VenueInputSchema>;

export const VenueTemplateSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
});
export type VenueTemplateSummary = z.infer<typeof VenueTemplateSummarySchema>;

export const VenueTemplateCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  slug: VenueSlugSchema.optional(),
});
export type VenueTemplateCreateInput = z.infer<typeof VenueTemplateCreateInputSchema>;

const OpeningRuleSchema = z.object({
  id: VenueResourceIdSchema,
  venueId: VenueResourceIdSchema,
  weekday: WeekdaySchema,
  startTime: TimeSchema,
  endTime: TimeSchema,
  note: z.string().nullable(),
  position: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OpeningRule = z.infer<typeof OpeningRuleSchema>;

const endsAfterStart = { path: ["endTime"], message: "End time must be after start time" };

export const OpeningRuleInputSchema = z
  .object({
    weekday: WeekdaySchema,
    startTime: TimeSchema,
    endTime: TimeSchema,
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine((input) => input.startTime < input.endTime, endsAfterStart);
export type OpeningRuleInput = z.infer<typeof OpeningRuleInputSchema>;

const DateOverrideSchema = z.object({
  id: VenueResourceIdSchema,
  venueId: VenueResourceIdSchema,
  date: DateKeySchema,
  kind: z.enum(["closed", "open"]),
  startTime: TimeSchema.nullable(),
  endTime: TimeSchema.nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DateOverride = z.infer<typeof DateOverrideSchema>;

export const DateOverrideInputSchema = z.discriminatedUnion("kind", [
  z.object({
    date: DateKeySchema,
    kind: z.literal("closed"),
    note: z.string().trim().max(500).nullable().optional(),
  }),
  z
    .object({
      date: DateKeySchema,
      kind: z.literal("open"),
      startTime: TimeSchema,
      endTime: TimeSchema,
      note: z.string().trim().max(500).nullable().optional(),
    })
    .refine((input) => input.startTime < input.endTime, endsAfterStart),
]);
export type DateOverrideInput = z.infer<typeof DateOverrideInputSchema>;

export const ShiftTemplateSchema = z.object({
  id: VenueResourceIdSchema,
  venueId: VenueResourceIdSchema,
  weekday: WeekdaySchema,
  title: z.string(),
  startTime: TimeSchema,
  endTime: TimeSchema,
  minPeople: z.number().int().min(0),
  maxPeople: z.number().int().min(0).nullable(),
  requireTargetForOpening: z.boolean(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ShiftTemplate = z.infer<typeof ShiftTemplateSchema>;

export const ShiftTemplateInputSchema = z
  .object({
    weekday: WeekdaySchema,
    title: z.string().trim().min(1).max(160),
    startTime: TimeSchema,
    endTime: TimeSchema,
    minPeople: z.number().int().min(0).default(1),
    maxPeople: z.number().int().min(0).nullable().optional(),
    requireTargetForOpening: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .refine((input) => input.startTime < input.endTime, endsAfterStart)
  .refine((input) => input.maxPeople == null || input.maxPeople >= input.minPeople, {
    path: ["maxPeople"],
    message: "Maximum people must be greater than or equal to required people",
  })
  .refine((input) => !input.requireTargetForOpening || input.minPeople >= 1, {
    path: ["minPeople"],
    message: "Target people must be at least one when it controls public opening",
  });
export type ShiftTemplateInput = z.infer<typeof ShiftTemplateInputSchema>;

/** Templates that one request creates together, for example the same shift on several weekdays: all or none. */
export const ShiftTemplateBatchInputSchema = z.object({
  templates: z.array(ShiftTemplateInputSchema).min(1).max(7),
});
export type ShiftTemplateBatchInput = z.infer<typeof ShiftTemplateBatchInputSchema>;

export const ShiftAssignmentSchema = z.object({
  id: VenueResourceIdSchema,
  venueId: VenueResourceIdSchema,
  templateId: VenueResourceIdSchema.nullable(),
  /** The shift's name, also after its template was paused or deleted; `null` for free time. */
  templateTitle: z.string().nullable(),
  userId: z.string(),
  userDisplayName: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ShiftAssignment = z.infer<typeof ShiftAssignmentSchema>;

export const UpcomingSlotSchema = z.object({
  date: DateKeySchema,
  template: ShiftTemplateSchema,
  startsAt: z.string(),
  endsAt: z.string(),
  assignedCount: z.number().int().min(0),
  minPeople: z.number().int().min(0),
  maxPeople: z.number().int().min(0).nullable(),
  missingPeople: z.number().int().min(0),
  full: z.boolean(),
  assignments: z.array(ShiftAssignmentSchema),
});
export type UpcomingSlot = z.infer<typeof UpcomingSlotSchema>;

export const FreeSignupInputSchema = z.object({
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  note: z.string().trim().max(500).nullable().optional(),
});

export const TemplateSignupInputSchema = z.object({
  date: DateKeySchema,
});

export const PublicMenuItemSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1_000).optional(),
    info: z.string().trim().max(1_000).optional(),
    allergens: z.string().trim().max(1_000).optional(),
    price: z.string().trim().max(120).optional(),
    image: z.string().nullable().optional(),
    availableFrom: DateKeySchema.nullable().optional(),
    availableUntil: DateKeySchema.nullable().optional(),
  })
  .passthrough()
  .refine((item) => !item.availableFrom || !item.availableUntil || item.availableFrom <= item.availableUntil, {
    path: ["availableUntil"],
    message: "Availability end must be on or after the start date",
  });
export type PublicMenuItem = z.infer<typeof PublicMenuItemSchema>;

const PublicSectionKindSchema = z.enum(["markdown", "menu", "notice", "links"]);

export const PublicSectionSchema = z.object({
  id: VenueResourceIdSchema,
  venueId: VenueResourceIdSchema,
  kind: PublicSectionKindSchema,
  title: z.string(),
  content: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  position: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PublicSection = z.infer<typeof PublicSectionSchema>;

/** Link schemes a visitor can follow safely; anything else, such as `javascript:`, never becomes a link. */
const PUBLIC_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

const PUBLIC_LINK_HREF_ERROR = "Use a full address starting with https://, http://, mailto:, or tel:, or a path starting with /";

/**
 * Where a link of a links section leads, or `null` when visitors cannot follow it: a full web, mail, or phone
 * address, or a path on this Cloud such as `/app/venue`. Saving a section and rendering it apply this one rule,
 * so the editor never keeps a link that the public page leaves out.
 */
export const publicLinkHref = (value: string): string | null => {
  const href = value.trim();
  // A path stays on this Cloud; `//host` and `/\host` would leave it for another host.
  if (href.startsWith("/")) return /^\/[/\\]/.test(href) ? null : href;
  try {
    const url = new URL(href);
    return PUBLIC_LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};

export const PublicSectionInputSchema = z
  .object({
    kind: PublicSectionKindSchema,
    title: z.string().trim().min(1).max(160),
    content: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(true),
    position: z.number().int().default(0),
  })
  .superRefine((input, ctx) => {
    if (input.kind === "links") {
      // Without links, a links section shows its text; with them, every address must be one visitors can follow.
      const links = input.content.links;
      if (links === undefined) return;
      if (!Array.isArray(links)) {
        ctx.addIssue({ code: "custom", path: ["content", "links"], message: "Links must be an array" });
        return;
      }
      links.forEach((link, index) => {
        const href = link && typeof link === "object" && "href" in link ? link.href : undefined;
        if (typeof href === "string" && publicLinkHref(href)) return;
        ctx.addIssue({ code: "custom", path: ["content", "links", index, "href"], message: PUBLIC_LINK_HREF_ERROR });
      });
      return;
    }
    if (input.kind !== "menu") return;
    const items = input.content.items;
    if (!Array.isArray(items)) {
      ctx.addIssue({ code: "custom", path: ["content", "items"], message: "Menu items must be an array" });
      return;
    }
    items.forEach((item, index) => {
      const result = PublicMenuItemSchema.safeParse(item);
      if (result.success) return;
      result.error.issues.forEach((issue) =>
        ctx.addIssue({ code: "custom", path: ["content", "items", index, ...issue.path], message: issue.message }),
      );
    });
  });
export type PublicSectionInput = z.infer<typeof PublicSectionInputSchema>;

/**
 * A section update. Omitted fields keep their stored value, so an edit never
 * publishes a draft (`enabled: false`) or moves the section by accident.
 */
export const PublicSectionPatchSchema = z.object({
  kind: PublicSectionKindSchema.optional(),
  title: z.string().trim().min(1).max(160).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  position: z.number().int().optional(),
});
export type PublicSectionPatch = z.infer<typeof PublicSectionPatchSchema>;

export const FeedbackEntrySchema = z.object({
  venueId: VenueResourceIdSchema,
  rating: z.number().int().min(1).max(5),
  comment: z.string().nullable(),
  createdAt: z.string(),
});
export type FeedbackEntry = z.infer<typeof FeedbackEntrySchema>;

export const FeedbackInputSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2_000).nullable().optional(),
});

/**
 * Feedback of the last N calendar days in the Venue's time zone, today
 * included. Counts, daily buckets, and the entry list share that window.
 */
const FeedbackSummarySchema = z.object({
  count: z.number().int().min(0),
  averageRating: z.number().nullable(),
  commentCount: z.number().int().min(0),
  buckets: z.array(z.object({ date: DateKeySchema, count: z.number().int(), averageRating: z.number().nullable() })),
});
export type FeedbackSummary = z.infer<typeof FeedbackSummarySchema>;

/** Feedback entries per page in the workspace table and the dashboard API. */
export const FEEDBACK_PAGE_SIZE = 50;

export const PublicOpeningSchema = z.object({
  kind: z.enum(["regular", "shift", "free"]),
  title: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
});
export type PublicOpening = z.infer<typeof PublicOpeningSchema>;

/** Days of exceptions the public status lists in advance: today and the 29 following days in the Venue's time zone. */
export const PUBLIC_EXCEPTION_DAYS = 30;

/**
 * A closed day or a special opening on the public page. Times are Venue clock times; the note is the one the
 * admin wrote for visitors, such as "Public holiday".
 */
export const PublicExceptionSchema = z.object({
  date: DateKeySchema,
  kind: z.enum(["closed", "open"]),
  startTime: TimeSchema.nullable(),
  endTime: TimeSchema.nullable(),
  note: z.string().nullable(),
});
export type PublicException = z.infer<typeof PublicExceptionSchema>;

export const PublicStatusSchema = z.object({
  venue: VenueSchema,
  open: z.boolean(),
  spontaneousOpen: z.boolean(),
  statusLabel: z.string(),
  todayLabel: z.string(),
  nextOpeningLabel: z.string().nullable(),
  activeWindowLabel: z.string().nullable(),
  upcomingOpenings: z.array(PublicOpeningSchema),
  /** Closed days and special openings of the next {@link PUBLIC_EXCEPTION_DAYS} days, today included, by date. */
  upcomingExceptions: z.array(PublicExceptionSchema),
  openingRules: z.array(OpeningRuleSchema),
  sections: z.array(PublicSectionSchema),
});
export type PublicStatus = z.infer<typeof PublicStatusSchema>;

/** Days the schedule's key figures cover: today and the six following days in the Venue's time zone. */
export const SCHEDULE_OUTLOOK_DAYS = 7;

/**
 * The schedule's key figures for a fixed window of {@link SCHEDULE_OUTLOOK_DAYS} days starting today in the
 * Venue's time zone, independent of the calendar window. Shifts that already ended do not count.
 */
export const ScheduleOutlookSchema = z.object({
  startDate: DateKeySchema,
  endDate: DateKeySchema,
  /** People still missing to reach the target, summed over the window's shifts. */
  missingPeople: z.number().int().min(0),
  /** The earliest shift in the window that still misses people; `null` when every shift reached its target. */
  nextGap: z
    .object({
      templateId: VenueResourceIdSchema,
      date: DateKeySchema,
      title: z.string(),
      startsAt: z.string(),
      endsAt: z.string(),
      missingPeople: z.number().int().min(1),
    })
    .nullable(),
});
export type ScheduleOutlook = z.infer<typeof ScheduleOutlookSchema>;

export const VenueDashboardSchema = z.object({
  venue: VenueSchema,
  openingRules: z.array(OpeningRuleSchema),
  /** Exceptions from a week ago through the next year. */
  overrides: z.array(DateOverrideSchema),
  /** Every shift template that was not deleted; a paused one has `active: false` and plans no slots. */
  templates: z.array(ShiftTemplateSchema),
  slots: z.array(UpcomingSlotSchema),
  /**
   * Sign-ups in the slot window that belong to none of `slots`: free time, and sign-ups for a paused shift
   * or for a shift time that has since changed. The calendar shows them as their own entries.
   */
  otherAssignments: z.array(ShiftAssignmentSchema),
  outlook: ScheduleOutlookSchema,
  assignments: z.array(ShiftAssignmentSchema),
  myUpcomingShifts: z.array(ShiftAssignmentSchema),
  myShiftCount: z.number().int().min(0),
  /** Every section for write and admin; for read, exactly the sections the public page shows. */
  sections: z.array(PublicSectionSchema),
  /** `null` below write permission: readers do not see visitor feedback. */
  feedback: FeedbackSummarySchema.nullable(),
  /** One page of the entries in the feedback window that match the search, newest first. */
  feedbackEntries: z.array(FeedbackEntrySchema),
  /**
   * Where `feedbackEntries` sits in the full result; `total` counts every matching entry, not only this page.
   * `null` when the request did not ask for entries (`includeFeedbackEntries`) or the caller does not see feedback.
   */
  feedbackEntriesPage: z
    .object({
      page: z.number().int().min(1),
      pageSize: z.number().int().min(1),
      total: z.number().int().min(0),
    })
    .nullable(),
});
export type VenueDashboard = z.infer<typeof VenueDashboardSchema>;

export const VenueDashboardQuerySchema = z.object({
  slotStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  slotDays: z.coerce.number().int().min(0).max(60).optional(),
  includeFeedbackEntries: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  feedbackDays: z.coerce.number().int().min(1).max(365).optional(),
  feedbackSearch: z.string().trim().max(200).optional(),
  /** `true` lists only entries with a comment; the counts and buckets stay those of the whole window. */
  feedbackComments: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  /** 1-based; the server clamps it to the last page. */
  feedbackPage: z.coerce.number().int().min(1).optional(),
});
