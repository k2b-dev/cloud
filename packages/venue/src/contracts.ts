import { z } from "zod";

const WeekdaySchema = z.number().int().min(0).max(6);
const TimeSchema = z.string().regex(/^\d{2}:\d{2}$/, "Expected HH:MM");
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

export const VenueInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  icon: z.string().trim().min(1).max(120).default("ti ti-building-carousel"),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and dashes"),
  description: z.string().trim().max(1_000).nullable().optional(),
  timezone: z.string().trim().min(1).max(80).default("Europe/Berlin"),
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
  slug: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and dashes")
    .optional(),
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

export const OpeningRuleInputSchema = z.object({
  weekday: WeekdaySchema,
  startTime: TimeSchema,
  endTime: TimeSchema,
  note: z.string().trim().max(500).nullable().optional(),
});
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
  z.object({
    date: DateKeySchema,
    kind: z.literal("open"),
    startTime: TimeSchema,
    endTime: TimeSchema,
    note: z.string().trim().max(500).nullable().optional(),
  }),
]);
export type DateOverrideInput = z.infer<typeof DateOverrideInputSchema>;

const ShiftTemplateSchema = z.object({
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
  .refine((input) => input.maxPeople == null || input.maxPeople >= input.minPeople, {
    path: ["maxPeople"],
    message: "Maximum people must be greater than or equal to required people",
  })
  .refine((input) => !input.requireTargetForOpening || input.minPeople >= 1, {
    path: ["minPeople"],
    message: "Target people must be at least one when it controls public opening",
  });
export type ShiftTemplateInput = z.infer<typeof ShiftTemplateInputSchema>;

export const ShiftAssignmentSchema = z.object({
  id: VenueResourceIdSchema,
  venueId: VenueResourceIdSchema,
  templateId: VenueResourceIdSchema.nullable(),
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

const PublicSectionSchema = z.object({
  id: VenueResourceIdSchema,
  venueId: VenueResourceIdSchema,
  kind: z.enum(["markdown", "menu", "notice", "links"]),
  title: z.string(),
  content: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  position: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PublicSection = z.infer<typeof PublicSectionSchema>;

export const PublicSectionInputSchema = z
  .object({
    kind: z.enum(["markdown", "menu", "notice", "links"]),
    title: z.string().trim().min(1).max(160),
    content: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(true),
    position: z.number().int().default(0),
  })
  .superRefine((input, ctx) => {
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

const FeedbackSummarySchema = z.object({
  count: z.number().int().min(0),
  averageRating: z.number().nullable(),
  buckets: z.array(z.object({ date: DateKeySchema, count: z.number().int(), averageRating: z.number().nullable() })),
});
export type FeedbackSummary = z.infer<typeof FeedbackSummarySchema>;

export const PublicOpeningSchema = z.object({
  kind: z.enum(["regular", "shift", "free"]),
  title: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
});
export type PublicOpening = z.infer<typeof PublicOpeningSchema>;

export const PublicStatusSchema = z.object({
  venue: VenueSchema,
  open: z.boolean(),
  spontaneousOpen: z.boolean(),
  statusLabel: z.string(),
  todayLabel: z.string(),
  nextOpeningLabel: z.string().nullable(),
  activeWindowLabel: z.string().nullable(),
  upcomingOpenings: z.array(PublicOpeningSchema),
  openingRules: z.array(OpeningRuleSchema),
  sections: z.array(PublicSectionSchema),
});
export type PublicStatus = z.infer<typeof PublicStatusSchema>;

export const VenueDashboardSchema = z.object({
  venue: VenueSchema,
  openingRules: z.array(OpeningRuleSchema),
  overrides: z.array(DateOverrideSchema),
  templates: z.array(ShiftTemplateSchema),
  slots: z.array(UpcomingSlotSchema),
  assignments: z.array(ShiftAssignmentSchema),
  myUpcomingShifts: z.array(ShiftAssignmentSchema),
  myShiftCount: z.number().int().min(0),
  /** Every section for write and admin; for read, exactly the sections the public page shows. */
  sections: z.array(PublicSectionSchema),
  /** `null` below write permission: readers do not see visitor feedback. */
  feedback: FeedbackSummarySchema.nullable(),
  feedbackEntries: z.array(FeedbackEntrySchema),
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
});
