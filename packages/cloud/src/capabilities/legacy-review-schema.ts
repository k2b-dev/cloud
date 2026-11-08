const CapabilityReviewDateTimeSchema = z.iso.datetime({ offset: true });
const CapabilityReviewDateSchema = z.union([z.iso.date(), CapabilityReviewDateTimeSchema]);

// Read-only schemas for persisted reviews. Never accepted from providers.
import { z } from "zod";
import {
  CAPABILITY_MAX_REVIEW_CONTENT_BYTES,
  CapabilityConsequenceSchema,
  CapabilityPersonSchema,
  CapabilitySentenceSchema,
  CloudResourceRefSchema,
} from "../contracts/capabilities";

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
const reviewTime = z.iso.datetime({ offset: true });
const reviewDay = z.iso.date();
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
export const LegacyCapabilityPreviewSchema = z.discriminatedUnion("kind", [
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
export type LegacyCapabilityPreview = z.infer<typeof LegacyCapabilityPreviewSchema>;
/** Complete passive content; no attachment bytes, HTML, omitted entries, or silently shortened strings. */
// Construct complete review validators in pure calls: unrelated browser consumers of resource refs do not need them.
export const LegacyCapabilityReviewContentSchema = /* @__PURE__ */ (() => {
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
export type LegacyCapabilityReviewContent = z.infer<typeof LegacyCapabilityReviewContentSchema>;
