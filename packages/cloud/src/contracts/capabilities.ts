import {
  type CapabilityStream,
  type CapabilityStreamDefinition,
  CapabilityStreamPolicySchema,
  CapabilityStreamSchema,
} from "./capability-streams";

export * from "./capability-streams";

import { z } from "zod";
import type { RequestAuthority } from "../server/middleware/auth";
import { CommandPathSchema } from "./commands";
import type { AccessSubject, RequestActor, User } from "./shared";

export const CAPABILITY_PROTOCOL_VERSION = 2 as const;
export const CAPABILITY_MAX_REQUEST_BYTES = 256 * 1024;
export const CAPABILITY_MAX_RESULT_BYTES = 256 * 1024;
export const CAPABILITY_MAX_CATALOG_BYTES = 2 * 1024 * 1024;
export const CAPABILITY_QUALIFIED_ID_MAX_LENGTH = 180;
export const CLOUD_RESOURCE_ID_MAX_LENGTH = 512;
export const CAPABILITY_APP_ID_MAX_LENGTH = 80;

export const CAPABILITY_FRAMEWORK_ERROR_CODES = {
  appUnavailable: "APP_UNAVAILABLE",
  capabilityNotFound: "CAPABILITY_NOT_FOUND",
  validationFailed: "VALIDATION_FAILED",
  schemaMismatch: "SCHEMA_MISMATCH",
  idempotencyKeyRequired: "IDEMPOTENCY_KEY_REQUIRED",
  idempotencyKeyNotAllowed: "IDEMPOTENCY_KEY_NOT_ALLOWED",
  idempotencyConflict: "IDEMPOTENCY_CONFLICT",
  idempotencyInProgress: "IDEMPOTENCY_IN_PROGRESS",
  idempotencyUncertain: "IDEMPOTENCY_UNCERTAIN",
  deadlineExceeded: "DEADLINE_EXCEEDED",
  actionOutcomeUnknown: "ACTION_OUTCOME_UNKNOWN",
  requestCancelled: "REQUEST_CANCELLED",
  invalidAppResponse: "INVALID_APP_RESPONSE",
  responseTooLarge: "RESPONSE_TOO_LARGE",
  internal: "INTERNAL",
} as const;

export const capabilityIdempotencyConflict = (
  message: string,
  details?: Record<string, unknown>,
): CapabilityError & { code: "IDEMPOTENCY_CONFLICT"; status: 409 } => ({
  code: CAPABILITY_FRAMEWORK_ERROR_CODES.idempotencyConflict,
  message,
  status: 409,
  ...(details ? { details } : {}),
});

/**
 * Cloud surface a capability invocation came from. The dispatcher resolves it
 * once, records it on the execution row, and forwards it to the owning app.
 */
export const CAPABILITY_ORIGINS = ["assistant", "mcp", "http", "app"] as const;
export type CapabilityOrigin = (typeof CAPABILITY_ORIGINS)[number];
export const CapabilityOriginSchema = z.enum(CAPABILITY_ORIGINS);

/** Transports the resolved origin from the Cloud dispatcher to the app endpoint. */
export const CAPABILITY_ORIGIN_HEADER = "x-cloud-capability-origin";

export const CapabilityIdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, "Idempotency keys must contain only visible ASCII characters");

const CAPABILITY_LOCAL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const CAPABILITY_QUALIFIED_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const CLOUD_PATH_PATTERN = /^\/(?![\\/])[^\\\u0000-\u001f\u007f]*$/;

export const CapabilityLocalIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(CAPABILITY_LOCAL_ID_PATTERN, "Use a stable lower-case capability id");

export const CapabilityQualifiedIdSchema = z
  .string()
  .min(3)
  .max(CAPABILITY_QUALIFIED_ID_MAX_LENGTH)
  .regex(CAPABILITY_QUALIFIED_ID_PATTERN, "Expected a namespaced capability id such as contacts.contact");

export const CloudResourceRefSchema = z
  .object({
    type: CapabilityQualifiedIdSchema.describe("Namespaced resource type declared by the owning app."),
    id: z.string().min(1).max(CLOUD_RESOURCE_ID_MAX_LENGTH).describe("Stable app-owned resource identifier."),
  })
  .strict();

export type CloudResourceRef = z.infer<typeof CloudResourceRefSchema>;

export { cloudResourceHref } from "./resource-href";

export const CloudResourceReferenceSchema = CloudResourceRefSchema.extend({
  title: z.string().min(1).max(500).optional().describe("Optional current user-facing resource label."),
  preview: z.string().max(2000).optional().describe("Optional short plain-text context for the resource."),
  icon: z.string().min(1).max(120).optional().describe("Optional presentation icon for the resource."),
}).strict();

export type CloudResourceReference = z.infer<typeof CloudResourceReferenceSchema>;

// Consumer permalinks may encode all 512 UTF-16 units of an id (up to 4,608 characters).
export const CloudResourceHrefSchema = z.string().min(1).max(8192).regex(CLOUD_PATH_PATTERN);

export const LinkedCloudResourceReferenceSchema = CloudResourceReferenceSchema.extend({
  href: z.union([CloudResourceHrefSchema, z.url({ protocol: /^https?$/ }).max(8192)]).optional(),
}).strict();

export const CapabilitySemanticLinkSchema = z
  .object({
    rel: z.enum(["open", "edit", "status", "preview", "download"]).describe("Semantic relationship; clients decide how to present it."),
    href: z
      .string()
      .min(1)
      .max(2048)
      .regex(CLOUD_PATH_PATTERN, "Capability links must be root-relative same-origin Cloud paths")
      .describe("Root-relative Cloud URL."),
    title: z.string().min(1).max(120).optional().describe("Optional human-readable link label."),
  })
  .strict();

export type CapabilitySemanticLink = z.infer<typeof CapabilitySemanticLinkSchema>;

const CapabilityReviewDateTimeSchema = z.string().datetime({ offset: true });
const CapabilityReviewDateSchema = z.union([z.iso.date(), CapabilityReviewDateTimeSchema]);
const CapabilityActionReviewDetailSchema = z
  .object({
    label: z.string().min(1).max(120),
    value: z.string().max(10_000),
    display: z.enum(["inline", "block"]).optional(),
    format: z.enum(["date", "date-time", "markdown"]).optional(),
  })
  .strict()
  .superRefine((detail, context) => {
    if (detail.format === "markdown" && detail.display !== "block") {
      context.addIssue({ code: "custom", path: ["display"], message: "Markdown review details require block display" });
    }
    const schema =
      detail.format === "date" ? CapabilityReviewDateSchema : detail.format === "date-time" ? CapabilityReviewDateTimeSchema : null;
    if (schema?.safeParse(detail.value).success === false) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message:
          detail.format === "date" ? "Date review values must use YYYY-MM-DD or RFC 3339" : "Date-time review values must use RFC 3339",
      });
    }
  });

/** @deprecated the next major release replaces this shape; return CapabilityActionCallReview. */
export const CapabilityActionReviewSchema = z
  .object({
    message: z.string().min(1).max(1000).describe("Plain-text description of the concrete Action consequence."),
    details: z.array(CapabilityActionReviewDetailSchema).max(20).optional(),
    links: z.array(CapabilitySemanticLinkSchema).max(10).optional(),
    approvalScope: z.string().min(1).max(200).optional().describe("Opaque app-owned scope for a rememberable Action approval."),
  })
  .strict();

/** @deprecated the next major release replaces this shape; return CapabilityActionCallReview. */
export type CapabilityActionReview = z.infer<typeof CapabilityActionReviewSchema>;

export const CAPABILITY_ASK_REASONS = [
  "sends",
  "deletes",
  "cannot_undo",
  "involves_people",
  "changes_access",
  "keeps_working",
  "sensitive",
  "app_asks",
] as const;
export type CapabilityAskReason = (typeof CAPABILITY_ASK_REASONS)[number];
export const CAPABILITY_REACHES = ["you", "draft", "shared"] as const;
export type CapabilityReach = (typeof CAPABILITY_REACHES)[number];
export const CAPABILITY_ACTION_OUTCOMES = ["running", "done", "rejected", "not_run", "unknown"] as const;
export type CapabilityActionOutcome = (typeof CAPABILITY_ACTION_OUTCOMES)[number];
export const CAPABILITY_MAX_REVIEW_BYTES = 32 * 1024;
/** Full review text and metadata, separate from the compact card and ordinary capability results. */
export const CAPABILITY_MAX_REVIEW_CONTENT_BYTES = 16 * 1024 * 1024;
export const CAPABILITY_MAX_REVIEW_RESPONSE_BYTES = CAPABILITY_MAX_REVIEW_CONTENT_BYTES + CAPABILITY_MAX_REVIEW_BYTES + 11;
export const CapabilityActionPolicySchema = z.union([
  z.object({ silent: z.enum(CAPABILITY_REACHES), routines: z.literal(false).optional() }).strict(),
  z.object({ ask: z.enum(CAPABILITY_ASK_REASONS) }).strict(),
]);
export type CapabilityActionPolicy = z.infer<typeof CapabilityActionPolicySchema>;

const reviewLine = (max: number, min = 1) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((text) => !/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u.test(text), "Contains unsafe characters");
const reviewBlock = (max: number) =>
  z
    .string()
    .max(max)
    .refine((text) => !/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u.test(text.replace(/[\n\t]/g, "")), "Contains unsafe characters");
export const CapabilityPersonSchema = z
  .object({ name: reviewLine(200).optional(), address: reviewLine(320).optional(), userId: z.uuid().optional() })
  .strict()
  .refine((person) => person.name !== undefined || person.address !== undefined, "A person needs a name or address");
export type CapabilityPerson = z.infer<typeof CapabilityPersonSchema>;
const reviewTime = z.iso.datetime({ offset: true });
const reviewDay = z.iso.date();
const reviewIcon = z.string().regex(/^ti ti-[a-z0-9-]+$/);
export const CapabilitySlotSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("object"),
      title: reviewLine(200),
      ref: CloudResourceRefSchema.optional(),
      icon: reviewIcon.optional(),
      gone: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("place"), title: reviewLine(200), ref: CloudResourceRefSchema.optional(), icon: reviewIcon.optional() })
    .strict(),
  z
    .object({
      kind: z.literal("person"),
      people: z.array(CapabilityPersonSchema).min(1).max(20),
      total: z.number().int().min(1).max(100_000).optional(),
    })
    .strict()
    .refine((slot) => slot.total === undefined || slot.total >= slot.people.length, "total is smaller than people"),
  z
    .object({ kind: z.literal("time"), start: z.string(), end: z.string().optional(), format: z.enum(["date", "date-time"]) })
    .strict()
    .superRefine((slot, ctx) => {
      const schema = slot.format === "date" ? reviewDay : reviewTime;
      for (const key of ["start", "end"] as const)
        if (slot[key] !== undefined && !schema.safeParse(slot[key]).success)
          ctx.addIssue({ code: "custom", path: [key], message: "Invalid date or time" });
      if (slot.end && (slot.format === "date" ? slot.end < slot.start : Date.parse(slot.end) < Date.parse(slot.start)))
        ctx.addIssue({ code: "custom", path: ["end"], message: "end precedes start" });
    }),
  z
    .object({
      kind: z.literal("count"),
      value: z.number().int().min(0).max(1_000_000_000),
      noun: z
        .object({
          zero: reviewLine(40).optional(),
          one: reviewLine(40).optional(),
          two: reviewLine(40).optional(),
          few: reviewLine(40).optional(),
          many: reviewLine(40).optional(),
          other: reviewLine(40),
        })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal("text"), value: reviewLine(200) }).strict(),
]);
export type CapabilitySlot = z.infer<typeof CapabilitySlotSchema>;
const reviewSlots = z
  .record(z.string().regex(/^[a-z][A-Za-z0-9]{0,31}$/), CapabilitySlotSchema)
  .refine((slots) => Object.keys(slots).length <= 6, "At most 6 slots");
const reviewTemplate = reviewLine(200).refine(
  (text) => !/[{}]/.test(text.replace(/\{[a-z][A-Za-z0-9]{0,31}\}/g, "")),
  "Invalid placeholder",
);
/** Context-free sentence rules, also used for consequence and rule sentences. */
export const capabilitySentenceIssues = (
  text: string,
  slots: Readonly<Record<string, CapabilitySlot>>,
  complete = true,
  chips = true,
): string[] => {
  const names = [...text.matchAll(/\{([a-z][A-Za-z0-9]{0,31})\}/g)].map((match) => match[1]!);
  const issues: string[] = [];
  if (/[{}]/.test(text.replace(/\{[a-z][A-Za-z0-9]{0,31}\}/g, ""))) issues.push("Invalid placeholder");
  for (const name of names) if (!Object.hasOwn(slots, name)) issues.push(`Unknown slot ${name}`);
  if (complete) for (const name of Object.keys(slots)) if (!names.includes(name)) issues.push(`Missing slot ${name}`);
  if (
    chips &&
    names.filter((name) => {
      const slot = Object.hasOwn(slots, name) ? slots[name] : undefined;
      return slot && slot.kind !== "text" && slot.kind !== "count";
    }).length > 3
  )
    issues.push("At most 3 chip slots");
  return issues;
};
const sentenceShape = { text: reviewTemplate, slots: reviewSlots.readonly().optional() };
const sentenceRefinement = (sentence: { text: string; slots?: Readonly<Record<string, CapabilitySlot>> }, ctx: z.RefinementCtx) => {
  for (const message of capabilitySentenceIssues(sentence.text, sentence.slots ?? {})) ctx.addIssue({ code: "custom", message });
};
export const CapabilitySentenceSchema = z.object(sentenceShape).strict().superRefine(sentenceRefinement);
export type CapabilitySentence = z.infer<typeof CapabilitySentenceSchema>;
export const CapabilityConsequenceSchema = z
  .object({ ...sentenceShape, mark: z.enum(["added", "removed"]).optional() })
  .strict()
  .superRefine(sentenceRefinement);
export type CapabilityConsequence = z.infer<typeof CapabilityConsequenceSchema>;
const previewPeople = (max: number) => z.array(CapabilityPersonSchema).max(max);
const extraCount = z.number().int().min(0).max(100_000);
const previewZone = reviewLine(200).refine((zone) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, "Invalid time zone");
export const CapabilityPreviewSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      from: CapabilityPersonSchema.optional(),
      to: previewPeople(50),
      cc: previewPeople(50).optional(),
      bcc: previewPeople(50).optional(),
      more: z.object({ to: extraCount.optional(), cc: extraCount.optional(), bcc: extraCount.optional() }).strict().optional(),
      subject: reviewLine(998, 0),
      body: reviewBlock(10_000),
      format: z.enum(["plain", "markdown"]),
      truncated: z.boolean().optional(),
      attachments: z
        .array(
          z
            .object({ name: reviewLine(255), size: z.number().int().nonnegative().optional(), ref: CloudResourceRefSchema.optional() })
            .strict(),
        )
        .max(50)
        .optional(),
      moreAttachments: extraCount.optional(),
      sendAt: reviewTime.optional(),
      warnings: z.array(reviewLine(300)).max(5).optional(),
    })
    .strict()
    .refine(
      (preview) =>
        preview.to.length +
          (preview.cc?.length ?? 0) +
          (preview.bcc?.length ?? 0) +
          (preview.more?.to ?? 0) +
          (preview.more?.cc ?? 0) +
          (preview.more?.bcc ?? 0) >
        0,
      "A message needs a recipient",
    ),
  z
    .object({
      kind: z.literal("event"),
      title: reviewLine(200),
      start: z.union([reviewDay, reviewTime]),
      end: z.union([reviewDay, reviewTime]).optional(),
      allDay: z.boolean().optional(),
      timeZone: previewZone.optional(),
      place: reviewLine(200).optional(),
      location: reviewLine(200).optional(),
      recurrence: reviewLine(200).optional(),
      attendees: previewPeople(50).optional(),
      description: reviewBlock(2000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task"),
      title: reviewLine(200),
      place: reviewLine(200).optional(),
      due: z.union([reviewDay, reviewTime]).optional(),
      assignees: previewPeople(20).optional(),
      status: reviewLine(60).optional(),
      checklist: z
        .array(z.object({ label: reviewLine(200), done: z.boolean() }).strict())
        .max(20)
        .optional(),
      tags: z.array(reviewLine(60)).max(10).optional(),
      description: reviewBlock(2000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("page"),
      title: reviewLine(200),
      place: reviewLine(200).optional(),
      body: reviewBlock(10_000),
      format: z.enum(["plain", "markdown"]),
      truncated: z.boolean().optional(),
      changes: z
        .array(z.object({ change: z.enum(["added", "removed"]), text: reviewBlock(2000) }).strict())
        .max(20)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      name: reviewLine(255),
      place: reviewLine(200).optional(),
      path: reviewLine(1024).optional(),
      size: z.number().int().nonnegative().optional(),
      mediaType: reviewLine(120).optional(),
      to: reviewLine(1024).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rule"),
      when: CapabilitySentenceSchema,
      does: reviewBlock(4000),
      may: z.array(CapabilityConsequenceSchema).max(12),
      seesChat: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("fields"),
      rows: z
        .array(
          z
            .object({
              label: reviewLine(60),
              value: reviewBlock(2000),
              before: reviewBlock(2000).optional(),
              format: z.enum(["date", "date-time"]).optional(),
            })
            .strict()
            .superRefine((row, context) => {
              const schema =
                row.format === "date" ? CapabilityReviewDateSchema : row.format === "date-time" ? CapabilityReviewDateTimeSchema : null;
              for (const key of ["value", "before"] as const)
                if (row[key] !== undefined && schema?.safeParse(row[key]).success === false)
                  context.addIssue({ code: "custom", path: [key], message: "Invalid date or time" });
            }),
        )
        .min(1)
        .max(12),
    })
    .strict(),
]);
export type CapabilityPreview = z.infer<typeof CapabilityPreviewSchema>;
/** Complete passive content; no attachment bytes, HTML, omitted entries, or silently shortened strings. */
// Construct complete review validators in pure calls: unrelated browser consumers of resource refs do not need them.
export const CapabilityReviewContentSchema = /* @__PURE__ */ (() => {
  const fullReviewPerson = z
    .object({
      name: z.string().max(200).optional(),
      address: z.string().max(320).optional(),
      userId: z.uuid().optional(),
    })
    .strict()
    .refine((person) => person.name !== undefined || person.address !== undefined, "A person needs a name or address");
  return z
    .discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("message"),
          baseRevision: z.number().int().nonnegative().optional(),
          from: fullReviewPerson.optional(),
          to: z.array(fullReviewPerson).max(600),
          cc: z.array(fullReviewPerson).max(600).optional(),
          bcc: z.array(fullReviewPerson).max(600).optional(),
          subject: z.string().max(998),
          body: z.string().max(CAPABILITY_MAX_REVIEW_CONTENT_BYTES),
          format: z.literal("plain"),
          attachments: z
            .array(
              z
                .object({
                  name: z.string().min(1).max(255),
                  size: z.number().int().nonnegative().optional(),
                  ref: CloudResourceRefSchema.optional(),
                })
                .strict(),
            )
            .max(202)
            .optional(),
          sendAt: reviewTime.optional(),
          warnings: z.array(z.string().max(300)).max(6).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("page"),
          baseRevision: z.number().int().nonnegative().optional(),
          title: z.string().max(200),
          place: z.string().max(200).optional(),
          body: z.string().max(CAPABILITY_MAX_REVIEW_CONTENT_BYTES),
          format: z.literal("plain"),
        })
        .strict(),
    ])
    .superRefine((content, ctx) => {
      if (content.kind === "message" && content.to.length + (content.cc?.length ?? 0) + (content.bcc?.length ?? 0) > 600)
        ctx.addIssue({ code: "custom", message: "Full review content exceeds 600 recipients" });
      if (new TextEncoder().encode(JSON.stringify(content)).byteLength > CAPABILITY_MAX_REVIEW_CONTENT_BYTES)
        ctx.addIssue({ code: "custom", message: "Full review content exceeds 16 MiB" });
    });
})();
export type CapabilityReviewContent = z.infer<typeof CapabilityReviewContentSchema>;
/** Cloud supplies this after storing a review. It is a locator, never an authorization token. */
export const CapabilityReviewContentRefSchema = /* @__PURE__ */ (() =>
  z
    .object({
      href: z
        .string()
        .regex(
          /^\/api\/approvals\/(?:[a-fA-F0-9-]{36}\/content|conversations\/[a-fA-F0-9-]{36}\/turns\/[a-fA-F0-9-]{36}\/reviews\/(?!\.{1,2}$)(?:[A-Za-z0-9_!~*'().-]|%[A-Fa-f0-9]{2})+)$/,
        )
        .max(2048),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict())();
export type CapabilityReviewContentRef = z.infer<typeof CapabilityReviewContentRefSchema>;
export const CapabilityActionCallReviewSchema = /* @__PURE__ */ (() =>
  z
    .object({
      locale: z.string(),
      sentence: z
        .object({
          action: reviewTemplate,
          running: reviewTemplate,
          done: reviewTemplate,
          confirm: reviewTemplate,
          decline: reviewTemplate,
          rejected: reviewTemplate.optional(),
          notRun: reviewTemplate.optional(),
          short: reviewTemplate.refine((text) => text.length <= 60, "short exceeds 60 characters").optional(),
        })
        .strict(),
      slots: reviewSlots.readonly(),
      preview: CapabilityPreviewSchema.optional(),
      content: CapabilityReviewContentSchema.optional(),
      consequences: z.array(CapabilityConsequenceSchema).max(6).optional(),
      ask: z.enum(CAPABILITY_ASK_REASONS).optional(),
      reach: z.enum(CAPABILITY_REACHES).optional(),
      effects: z.number().int().min(1).max(1000).optional(),
      check: z
        .object({ query: CapabilityLocalIdSchema, input: z.record(z.string(), z.unknown()) })
        .strict()
        .optional(),
      scope: z.string().min(1).max(200).optional(),
      links: z.array(CapabilitySemanticLinkSchema).max(10).optional(),
    })
    .strict()
    .superRefine((review, ctx) => {
      for (const [form, text] of Object.entries(review.sentence)) {
        if (text === undefined) continue;
        const complete = form === "action" || form === "running" || form === "done";
        for (const message of capabilitySentenceIssues(text, review.slots, complete, form === "action"))
          ctx.addIssue({ code: "custom", path: ["sentence", form], message });
        if ((form === "confirm" || form === "decline") && [...text.matchAll(/\{[a-z][A-Za-z0-9]{0,31}\}/g)].length > 1)
          ctx.addIssue({ code: "custom", path: ["sentence", form], message: "Buttons name at most one slot" });
      }
    }))();
export type CapabilityActionCallReview = z.infer<typeof CapabilityActionCallReviewSchema>;
export type CapabilityActionReviewData = CapabilityActionCallReview | CapabilityActionReview;
export const CapabilityActionReviewDataSchema = /* @__PURE__ */ (() =>
  z
    .unknown()
    .transform((value, ctx) => {
      const schema =
        value !== null && typeof value === "object" && Object.hasOwn(value, "sentence")
          ? CapabilityActionCallReviewSchema
          : CapabilityActionReviewSchema;
      const parsed = schema.safeParse(value);
      if (parsed.success) return parsed.data;
      for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
      return z.NEVER;
    })
    .pipe(z.union([CapabilityActionCallReviewSchema, CapabilityActionReviewSchema])))();
/** Compact Cloud presentation. Providers return the strict review above, never a client-supplied content locator. */
export const CapabilityActionReviewPresentationSchema = /* @__PURE__ */ (() =>
  z.union([
    CapabilityActionCallReviewSchema.safeExtend({ contentRef: CapabilityReviewContentRefSchema.optional() }),
    CapabilityActionReviewSchema,
  ]))();
export type CapabilityActionReviewPresentation = z.infer<typeof CapabilityActionReviewPresentationSchema>;
export const CapabilityActionReceiptSchema = z
  .object({ ...sentenceShape, preview: CapabilityPreviewSchema.optional() })
  .strict()
  .superRefine(sentenceRefinement);
export type CapabilityActionReceipt = z.infer<typeof CapabilityActionReceiptSchema>;
export const CapabilityActionCheckSchema = z
  .object({ outcome: z.enum(["done", "not_done", "pending"]), receipt: CapabilityActionReceiptSchema.optional() })
  .strict();
export type CapabilityActionCheck = z.infer<typeof CapabilityActionCheckSchema>;

export const CapabilityPageSchema = z.discriminatedUnion("hasMore", [
  z
    .object({
      hasMore: z.literal(true).describe("Another page is available."),
      nextCursor: z.string().min(1).max(2048).describe("Opaque cursor for the next page."),
    })
    .strict(),
  z
    .object({
      hasMore: z.literal(false).describe("This is the final page."),
    })
    .strict(),
]);

export type CapabilityPage = z.infer<typeof CapabilityPageSchema>;

export const capabilityPage = (nextCursor?: string | null): CapabilityPage =>
  nextCursor === undefined || nextCursor === null ? { hasMore: false } : { hasMore: true, nextCursor };

// Presentation work is bounded independently of the result's byte envelope.
const CapabilityDataPathSchema = z.array(z.string().max(500)).max(16);
export const CapabilityTablePresentationSchema = z
  .object({
    kind: z.literal("table"),
    rowsPath: CapabilityDataPathSchema,
    columns: z
      .array(
        z
          .object({
            path: CapabilityDataPathSchema,
            label: z.string().max(500),
            format: z.enum(["text", "number", "date", "datetime"]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    rowLinksPath: CapabilityDataPathSchema.optional(),
  })
  .strict();
export type CapabilityTablePresentation = z.infer<typeof CapabilityTablePresentationSchema>;

/** Resolve own JSON properties only. Paths are data, never expressions. */
export const capabilityDataAtPath = (data: unknown, path: readonly string[]): unknown => {
  let value = data;
  for (const segment of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) return undefined;
    value = Object.getOwnPropertyDescriptor(value, segment)?.value;
  }
  return value;
};

export type CapabilityResult<T> = {
  data: T;
  stream?: CapabilityStream;
  /** Provider-authored, user-facing summary of the successful result. Render as escaped plain text. */
  summary?: string;
  receipt?: CapabilityActionReceipt;
  refs?: CloudResourceReference[];
  page?: CapabilityPage;
  links?: CapabilitySemanticLink[];
  presentation?: CapabilityTablePresentation;
};

// Published JSON schemas (Core's result check, each MCP tool's outputSchema) describe a receipt as an opaque object,
// so they stay as small as before receipts existed; Core then checks it with the shared receipt rules. Zod readers
// (the producer, stream results, consumers) keep the full receipt shape.
const resultSchema = <T extends z.ZodType>(
  data: T,
  options: { consumer?: boolean; opaqueReceipt: boolean },
): z.ZodType<CapabilityResult<z.output<T>>> =>
  z
    .object({
      data,
      stream: CapabilityStreamSchema.optional(),
      summary: z.string().trim().min(1).max(500).optional(),
      refs: z
        .array(options.consumer ? LinkedCloudResourceReferenceSchema : CloudResourceReferenceSchema)
        .max(100)
        .optional(),
      page: CapabilityPageSchema.optional(),
      links: z.array(CapabilitySemanticLinkSchema).max(20).optional(),
      receipt: options.opaqueReceipt
        ? z.record(z.string(), z.unknown()).optional()
        : options.consumer
          ? CapabilityActionReceiptSchema.optional().catch(undefined)
          : CapabilityActionReceiptSchema.optional(),
      presentation: options.consumer
        ? CapabilityTablePresentationSchema.optional().catch(undefined)
        : CapabilityTablePresentationSchema.optional(),
    })
    .strict()
    .superRefine((result, context) => {
      if (
        !options.consumer &&
        result.presentation &&
        !Array.isArray(capabilityDataAtPath(capabilityDataAtPath(result, ["data"]), result.presentation.rowsPath))
      ) {
        context.addIssue({
          code: "custom",
          path: ["presentation", "rowsPath"],
          message: "Table rowsPath must reference an array in data.",
        });
      }
    }) as unknown as z.ZodType<CapabilityResult<z.output<T>>>;

export const capabilityResultSchema = <T extends z.ZodType>(
  data: T,
  options?: { consumer?: boolean },
): z.ZodType<CapabilityResult<z.output<T>>> => resultSchema(data, { consumer: options?.consumer, opaqueReceipt: false });

export const capabilityResultJsonSchema = (
  dataSchema: Record<string, unknown>,
  options?: { consumer?: boolean },
): Record<string, unknown> =>
  z.toJSONSchema(resultSchema(z.fromJSONSchema(structuredClone(dataSchema)), { consumer: options?.consumer, opaqueReceipt: true }), {
    io: "output",
  }) as Record<string, unknown>;

export const CapabilityErrorSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1000),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const CAPABILITY_ERROR_STATUSES = [400, 401, 403, 404, 409, 429, 499, 500, 502, 503, 504] as const;
export type CapabilityErrorStatus = (typeof CAPABILITY_ERROR_STATUSES)[number];
export type CapabilityError = {
  code: string;
  message: string;
  status: CapabilityErrorStatus;
  details?: Record<string, unknown>;
};
export type CapabilityInvocationResult<T> = { ok: true; data: CapabilityResult<T> } | { ok: false; error: CapabilityError };
export type CapabilityActionReviewResult = { ok: true; data: CapabilityActionReviewData } | { ok: false; error: CapabilityError };

export const CloudResourceViewSchema = z
  .object({
    ref: CloudResourceRefSchema.describe("Stable identity of the result."),
    title: z.string().min(1).max(500).describe("Primary result label."),
    preview: z.string().max(2000).optional().describe("Short plain-text result preview."),
    icon: z.string().min(1).max(120).optional().describe("Optional presentation icon."),
    priority: z.number().int().min(0).max(9).optional().describe("App-local relevance hint from zero to nine."),
    metadata: z
      .array(
        z
          .object({
            label: z.string().min(1).max(120),
            value: z.string().max(1000),
          })
          .strict(),
      )
      .max(20)
      .optional()
      .describe("Small structured metadata shown with the result."),
    links: z.array(CapabilitySemanticLinkSchema).min(1).max(10).describe("Semantic links for the resource."),
  })
  .strict();

export type CloudResourceView = z.infer<typeof CloudResourceViewSchema>;

export const UniversalSearchInputSchema = z
  .object({
    query: z.string().max(500).describe("User-entered search text. Empty text is allowed when a facet narrows the query."),
    tags: z.array(z.string().min(1).max(64)).max(20).describe("Canonical search facets supported by this query."),
    scope: CloudResourceRefSchema.optional().describe(
      "Optional resource containing the search results; must be an explicitly supported scope type.",
    ),
    limit: z.number().int().min(1).max(100).describe("Maximum number of results to return."),
  })
  .strict();

export type UniversalSearchInput = z.infer<typeof UniversalSearchInputSchema>;

export const UniversalSearchDataSchema = z.array(CloudResourceViewSchema).max(100);
export type UniversalSearchData = z.infer<typeof UniversalSearchDataSchema>;

export type CapabilityExecutionContext = {
  /** One read-only cross-app dependency under this invocation, through Core. */
  query?: <T extends z.ZodType>(
    invocation: { appId: string; capabilityId: string; input: unknown; signal?: AbortSignal },
    dataSchema: T,
  ) => Promise<import("../capabilities/types").CapabilityClientResult<z.output<T>>>;
  /**
   * Resolved request authority, supplied by the framework for execution, review
   * and streams. Optional for existing in-process callers; authority-aware
   * services fail closed when it is absent. Preserve its credential limits.
   */
  authority?: RequestAuthority;
  actor: RequestActor;
  accessSubject: AccessSubject;
  user: User | null;
  idempotencyKey?: string;
  /**
   * Canonical BCP 47 locale of the originating request, transported as
   * invocation metadata (never inside the input schema or auth token). Use it
   * for human-facing formatting or `@k2b/stdlib` message catalogs; stable
   * error codes and data must not depend on it.
   */
  locale: string;
  /**
   * Correlation id of the originating Cloud request. Write it into the app's
   * own audit rows so a capability execution record and the app's domain trail
   * can be joined without sharing payloads.
   */
  requestId: string;
  /** Cloud surface that invoked this capability. */
  origin: CapabilityOrigin;
  /** Caller cancellation or shared dispatch deadline; forward it to expensive work. */
  signal: AbortSignal;
};

export type CapabilityResourceTypeDefinition = {
  title: string;
  description: string;
  icon?: string;
  reader?: string;
};

export type CapabilitySearchTagDefinition = {
  tag: string;
  title: string;
  description: string;
  aliases?: readonly string[];
};

export type CapabilityUniversalSearchDefinition = {
  tags: readonly CapabilitySearchTagDefinition[];
  /** Local resource types whose contents this Query can search. */
  scopeTypes?: readonly string[];
};

export type CapabilitySchemaPresentation = Readonly<Record<string, string>>;

/**
 * @deprecated removed with the next major; return per-call CapabilityActionCallReview sentence forms.
 *
 * What one Action does, in words people read in approvals, receipts, and step rows. Each sentence is a
 * template: `{input.to}` inserts a field of the validated call input by its dotted schema path, and
 * `done` may also read the Action's result data with `{data.id}`. Cloud inserts values as escaped,
 * bounded plain text, formats fields with a `date` or `date-time` schema format for the reader, and
 * names an object by its email, address, or path before its display name. A sentence whose value is
 * missing falls back to the generic wording, so every sentence stays optional. A `done` sentence
 * replaces the result's runtime summary in the receipt.
 */
export type CapabilityActionSentences = {
  /** What will happen, as a short instruction: "Send email to {input.to}". */
  approval?: string;
  /** What happened after the Action ran: "Sent email to {input.to}". */
  done?: string;
  /** What did not happen because the person rejected it: "Did not send email to {input.to}". */
  rejected?: string;
  /** What did not happen because the turn ended first: "Email to {input.to} not sent". */
  notRun?: string;
};

export type CapabilityOperationPresentationTranslation = {
  title?: string;
  description?: string;
  /** Human descriptions keyed by a stable dotted field path such as `filter.tags[]`. */
  input?: CapabilitySchemaPresentation;
  /** Human descriptions keyed by a stable dotted field path such as `items[].name`. */
  data?: CapabilitySchemaPresentation;
  /** Search-tag presentation keyed by the stable tag token. */
  searchTags?: Readonly<Record<string, { title?: string; description?: string }>>;
  /** @deprecated removed with the next major; return per-call review forms. */
  sentences?: CapabilityActionSentences;
};

export type CapabilityPresentationTranslation = {
  types?: Readonly<Record<string, { title?: string; description?: string }>>;
  queries?: Readonly<Record<string, CapabilityOperationPresentationTranslation>>;
  actions?: Readonly<Record<string, CapabilityOperationPresentationTranslation>>;
  commands?: Readonly<
    Record<
      string,
      Pick<CapabilityOperationPresentationTranslation, "title" | "description" | "input"> & {
        /** Translated search words, with the same bounds as the base Command keywords. */
        keywords?: readonly string[];
      }
    >
  >;
};

export type CapabilityPresentationCatalog = {
  /** Locale of the complete Type, Query, Action, search-tag, and schema presentation. */
  baseLocale: string;
  /** @deprecated removed with the next major; return per-call review forms. */
  sentences?: Readonly<Record<string, CapabilityActionSentences>>;
  /** Partial presentation overlays with exact -> ancestor -> base fallback. */
  translations: Readonly<Record<string, CapabilityPresentationTranslation>>;
};

export type CapabilityQueryDefinition<Input extends z.ZodType = z.ZodType<any>, Data extends z.ZodType = z.ZodType<any>> = {
  title: string;
  description: string;
  input: Input;
  data: Data;
  openWorld: boolean;
  stream?: CapabilityStreamDefinition;
  universalSearch?: CapabilityUniversalSearchDefinition;
  run: (
    input: z.output<Input>,
    context: CapabilityExecutionContext,
  ) => CapabilityInvocationResult<z.output<Data>> | Promise<CapabilityInvocationResult<z.output<Data>>>;
};

export type CapabilityIdempotencyPolicy = "none" | "required";
export type CapabilityActionApprovalPolicy = "rememberable" | "none";

export type CapabilityActionDefinition<Input extends z.ZodType = z.ZodType<any>, Data extends z.ZodType = z.ZodType<any>> = {
  title: string;
  description: string;
  input: Input;
  data: Data;
  destructive: boolean;
  openWorld: boolean;
  stream?: CapabilityStreamDefinition;
  idempotency: CapabilityIdempotencyPolicy;
  /** @deprecated removed with the next major; declare policy. */
  approval?: CapabilityActionApprovalPolicy;
  policy?: CapabilityActionPolicy;
  review?: (
    input: z.output<Input>,
    context: CapabilityExecutionContext,
  ) => CapabilityActionReviewResult | Promise<CapabilityActionReviewResult>;
  run: (
    input: z.output<Input>,
    context: CapabilityExecutionContext,
  ) => CapabilityInvocationResult<z.output<Data>> | Promise<CapabilityInvocationResult<z.output<Data>>>;
};

/** A declarative UI entry. Resolution never executes application code or writes domain data. */
export type CapabilityCommandDefinition = {
  title: string;
  description: string;
  icon?: string;
  keywords?: readonly string[];
  input: z.ZodType;
  path: string;
};

export const CapabilityCommandManifestSchema = z
  .object({
    localId: CapabilityLocalIdSchema,
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    icon: z.string().min(1).max(120).optional(),
    keywords: z.array(z.string().min(1).max(120)).max(30),
    inputSchema: z.record(z.string(), z.unknown()),
    path: CommandPathSchema,
  })
  .strict();
export type CapabilityCommandManifest = z.infer<typeof CapabilityCommandManifestSchema>;

type CapabilityDefinitionCatalog<T> = Readonly<Record<string, T>>;

/** Offers files to other apps: local IDs of the list Query, the read Query, and the optional save Action. */
export type CapabilityFileProviderDeclaration = { list: string; read: string; save?: string };

export type CapabilityDefinitions = {
  protocolVersion: typeof CAPABILITY_PROTOCOL_VERSION;
  presentation?: CapabilityPresentationCatalog;
  types?: CapabilityDefinitionCatalog<CapabilityResourceTypeDefinition>;
  queries?: CapabilityDefinitionCatalog<CapabilityQueryDefinition>;
  actions?: CapabilityDefinitionCatalog<CapabilityActionDefinition>;
  commands?: CapabilityDefinitionCatalog<CapabilityCommandDefinition>;
  fileProvider?: CapabilityFileProviderDeclaration;
};

/**
 * Declares one app's public capability surface. Runtime compilation happens
 * in defineApp.start(), where the app id is available for namespacing.
 */
export const defineCapabilities = <const T extends CapabilityDefinitions>(definitions: T): T => definitions;

export const CapabilityResourceTypeManifestSchema = z
  .object({
    localId: CapabilityLocalIdSchema,
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    icon: z.string().min(1).max(120).optional(),
    reader: CapabilityLocalIdSchema.optional(),
  })
  .strict();

export const CapabilitySearchTagManifestSchema = z
  .object({
    tag: z.string().min(1).max(64),
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    aliases: z.array(z.string().min(1).max(64)).max(20).optional(),
  })
  .strict();

const CapabilityOperationManifestBaseSchema = z
  .object({
    localId: CapabilityLocalIdSchema,
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    inputSchema: z.record(z.string(), z.unknown()),
    dataSchema: z.record(z.string(), z.unknown()),
    stream: CapabilityStreamPolicySchema.optional(),
    schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const CapabilityQueryManifestSchema = CapabilityOperationManifestBaseSchema.extend({
  openWorld: z.boolean(),
  universalSearch: z
    .object({ tags: z.array(CapabilitySearchTagManifestSchema).max(100), scopeTypes: z.array(CapabilityLocalIdSchema).max(100).optional() })
    .strict()
    .optional(),
}).strict();

export const CapabilityActionManifestSchema = CapabilityOperationManifestBaseSchema.extend({
  destructive: z.boolean(),
  openWorld: z.boolean(),
  idempotency: z.enum(["none", "required"]),
  approval: z.enum(["rememberable", "none"]).optional(),
  review: z.literal(true).optional(),
}).strict();

export const CapabilityAppIdSchema = z
  .string()
  .min(1)
  .max(CAPABILITY_APP_ID_MAX_LENGTH)
  .regex(/^[a-z][a-z0-9-]*$/);

const MAX_MANIFEST_ENTRIES = 200;

export const CapabilityFileProviderManifestSchema = z
  .object({ list: CapabilityLocalIdSchema, read: CapabilityLocalIdSchema, save: CapabilityLocalIdSchema.optional() })
  .strict();

/** Keeps the sent entries this release reads completely. */
const readEntries = <T extends z.ZodType>(values: unknown, entry: T): z.output<T>[] | null => {
  // Not a bounded list: leave the value to the manifest schema, which rejects it.
  if (!Array.isArray(values) || values.length > MAX_MANIFEST_ENTRIES) return null;
  return values.flatMap((value) => {
    const parsed = entry.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
};

/**
 * Reads what this release understands from a manifest that a newer release may have produced.
 *
 * - Unknown top-level fields are ignored. Additions there must retain conservative behavior through
 *   existing fields for older readers; Action policies carry the corresponding derived approval.
 *   Other restrictions belong inside their entry.
 * - An entry with a field or value from a newer release is left out rather than stripped: its unknown
 *   part may change how the entry runs or who may use it, so guessing could widen access.
 * - Entries that depend on an entry that is not there follow it: a Query scoped to a missing type is
 *   left out, and a type whose reader is missing keeps no reader.
 * - A file provider with a field from a newer release is left out. Whether its operations are still
 *   there and match the contract is `fileProviderIssues`' job, which Core and consumers run.
 *
 * - An unreadable policy or one inconsistent with derived approval, review, or effect flags leaves
 *   out its Action. Policies for unknown Actions are dropped.
 *
 * Every other entry stays available.
 */
const readableManifest = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const sent = value as Record<string, unknown>;
  const types = readEntries(sent.types, CapabilityResourceTypeManifestSchema);
  const queries = readEntries(sent.queries, CapabilityQueryManifestSchema);
  const actions = readEntries(sent.actions, CapabilityActionManifestSchema);
  const commands = readEntries(sent.commands, CapabilityCommandManifestSchema);
  if (!types || !queries || !actions || !commands) return value;
  const typeIds = new Set(types.map((type) => type.localId));
  const readableQueries = queries.filter((query) => query.universalSearch?.scopeTypes?.every((type) => typeIds.has(type)) ?? true);
  const queryIds = new Set(readableQueries.map((query) => query.localId));
  const policies: Record<string, CapabilityActionPolicy> = {};
  const sentPolicies = sent.policies;
  // Not a plain policy map: leave the value to the manifest schema, which rejects it.
  if (
    sentPolicies !== undefined &&
    (sentPolicies === null ||
      typeof sentPolicies !== "object" ||
      (Object.getPrototypeOf(sentPolicies) !== Object.prototype && Object.getPrototypeOf(sentPolicies) !== null))
  )
    return value;
  const readableActions = actions.filter((action) => {
    if (!sentPolicies || typeof sentPolicies !== "object" || !Object.hasOwn(sentPolicies, action.localId)) return true;
    const parsed = CapabilityActionPolicySchema.safeParse(Object.getOwnPropertyDescriptor(sentPolicies, action.localId)?.value);
    if (!parsed.success) return false;
    const policy = parsed.data;
    const approval = "silent" in policy ? "rememberable" : undefined;
    if (action.approval !== approval || !action.review || ("silent" in policy && (action.destructive || action.openWorld))) return false;
    policies[action.localId] = policy;
    return true;
  });
  const { fileProvider: sentProvider, policies: _policies, ...rest } = sent;
  const provider = CapabilityFileProviderManifestSchema.safeParse(sentProvider);
  return {
    ...rest,
    ...(provider.success ? { fileProvider: provider.data } : {}),
    types: types.map((type) => {
      if (!type.reader || queryIds.has(type.reader)) return type;
      const { reader: _missing, ...withoutReader } = type;
      return withoutReader;
    }),
    queries: readableQueries,
    actions: readableActions,
    ...(sentPolicies !== undefined ? { policies } : {}),
    commands,
  };
};

/**
 * Reads a manifest from any Cloud release with the same protocol version (see `readableManifest`).
 * Producers stay strict: `app.start()` registers exactly the manifest its release defines.
 */
export const CapabilityManifestSchema = z.preprocess(
  readableManifest,
  z.object({
    protocolVersion: z.literal(CAPABILITY_PROTOCOL_VERSION),
    appId: CapabilityAppIdSchema,
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    types: z.array(CapabilityResourceTypeManifestSchema).max(MAX_MANIFEST_ENTRIES),
    queries: z.array(CapabilityQueryManifestSchema).max(MAX_MANIFEST_ENTRIES),
    actions: z.array(CapabilityActionManifestSchema).max(MAX_MANIFEST_ENTRIES),
    commands: z.array(CapabilityCommandManifestSchema).max(MAX_MANIFEST_ENTRIES),
    // Optional without a default: a manifest without a provider keeps the shape and hash of earlier releases.
    fileProvider: CapabilityFileProviderManifestSchema.optional(),
    policies: z.record(CapabilityLocalIdSchema, CapabilityActionPolicySchema).optional(),
  }),
);

export type CapabilityResourceTypeManifest = z.infer<typeof CapabilityResourceTypeManifestSchema>;
export type CapabilityQueryManifest = z.infer<typeof CapabilityQueryManifestSchema>;
export type CapabilityActionManifest = z.infer<typeof CapabilityActionManifestSchema>;
export type CapabilitySearchTagManifest = z.infer<typeof CapabilitySearchTagManifestSchema>;
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

export const capabilityActionPolicy = (manifest: CapabilityManifest, localId: string): CapabilityActionPolicy | undefined =>
  manifest.policies && Object.hasOwn(manifest.policies, localId) ? manifest.policies[localId] : undefined;

export const cloudResourceRefAppId = (ref: CloudResourceRef): string => ref.type.slice(0, ref.type.indexOf("."));

/** Resolves a resource reference against one current, validated app manifest. */
export const resolveCapabilityResourceReader = (manifest: CapabilityManifest, ref: CloudResourceRef): CapabilityQueryManifest | null => {
  if (cloudResourceRefAppId(ref) !== manifest.appId) return null;
  const prefix = `${manifest.appId}.`;
  const type = manifest.types.find((candidate) => candidate.localId === ref.type.slice(prefix.length));
  if (!type?.reader) return null;
  return manifest.queries.find((candidate) => candidate.localId === type.reader) ?? null;
};

/** Like the manifest, catalog entries, pages, and their pagination ignore fields that a newer Cloud release added. */
export const CapabilityCatalogAppSchema = z.object({
  appId: CapabilityAppIdSchema,
  appName: z.string().min(1).max(200),
  appIcon: z.string().min(1).max(120),
  appDescription: z.string().max(1000),
  manifest: CapabilityManifestSchema,
});

export const CapabilityCatalogSchema = z.object({
  protocolVersion: z.literal(CAPABILITY_PROTOCOL_VERSION),
  apps: z.array(CapabilityCatalogAppSchema).max(25),
  page: z.discriminatedUnion("hasMore", [CapabilityPageSchema.options[0].strip(), CapabilityPageSchema.options[1].strip()]),
});

export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>;
