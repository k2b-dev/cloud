import {
  type CapabilitySemanticLink,
  CapabilitySemanticLinkSchema,
  CloudResourceRefSchema,
  CloudResourceViewSchema,
  ContactDirectoryMatchSchema,
} from "@k2b/cloud/contracts";
import { z } from "zod";

const timestampSchema = z.string().datetime({ offset: true });
const nullableTextSchema = z.string().nullable();
const spacesResourceIdSchema = z.string().regex(/^[0-9A-Za-z]{6}$/);
const mailResourceIdSchema = z.string().regex(/^[0-9A-Za-z]{6}$/);

export const normalizedContactEmailSchema = z.email().max(320);

export const contactOpenHref = (links: readonly CapabilitySemanticLink[] | undefined): string | null =>
  links?.find((link) => link.rel === "open")?.href ?? links?.find((link) => link.rel === "edit")?.href ?? null;

/** A contact-directory match as Mail exposes it: provider links collapse into one root-relative `openHref`. */
export const contactResolveMatchSchema = ContactDirectoryMatchSchema.extend({
  openHref: CapabilitySemanticLinkSchema.shape.href.nullable(),
}).passthrough();

export const calendarAddressSchema = z.object({ name: z.string().max(500).nullable(), address: z.email().max(320) }).passthrough();
export type CalendarAddress = z.infer<typeof calendarAddressSchema>;
export const calendarParticipationStatusSchema = z.enum(["accepted", "tentative", "declined"]);
export type CalendarParticipationStatus = z.infer<typeof calendarParticipationStatusSchema>;

const calendarAttendeeSchema = calendarAddressSchema.extend({
  participationStatus: z.enum(["needs_action", "accepted", "tentative", "declined", "delegated", "unknown"]),
  role: z.enum(["required", "optional", "chair", "unknown"]),
  responseRequested: z.boolean(),
});
const calendarInvitationSchema = z
  .object({
    method: z.enum(["request", "cancel", "reply", "publish", "unknown"]),
    uid: z.string().min(1).max(1024),
    sequence: z.number().int().nonnegative(),
    status: z.enum(["confirmed", "tentative", "cancelled", "unknown"]),
    title: z.string().min(1).max(200),
    description: z.string().max(5000).nullable(),
    location: z.string().max(500).nullable(),
    url: z.url().max(2000).nullable(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    allDay: z.boolean(),
    recurrenceRule: z.string().max(4096).nullable(),
    organizer: calendarAddressSchema.nullable(),
    attendees: z.array(calendarAttendeeSchema).max(500),
  })
  .passthrough();
const calendarResponseStateSchema = z
  .object({
    participationStatus: calendarParticipationStatusSchema,
    state: z.literal("drafted"),
    draftId: mailResourceIdSchema,
    updatedAt: z.string().datetime(),
  })
  .passthrough();
const canonicalSpacesItemHref = (spaceId: string, itemId: string): string => `/app/spaces/${spaceId}?item=${itemId}`;
const calendarInvitationExistingSchema = z
  .object({
    itemId: spacesResourceIdSchema,
    spaceId: spacesResourceIdSchema,
    href: z.string(),
    sequence: z.number().int().nonnegative(),
    method: z.enum(["request", "cancel", "reply", "publish", "unknown"]),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.href !== canonicalSpacesItemHref(value.spaceId, value.itemId)) {
      context.addIssue({ code: "custom", path: ["href"], message: "href must match the Space and item IDs" });
    }
  });
export const calendarInvitationPreviewSchema = z
  .object({
    invitation: calendarInvitationSchema,
    response: calendarResponseStateSchema.nullable(),
    existing: calendarInvitationExistingSchema.nullable(),
  })
  .passthrough();
export type CalendarInvitationPreview = z.infer<typeof calendarInvitationPreviewSchema>;

export const calendarInvitationImportResultSchema = z
  .object({
    itemId: spacesResourceIdSchema,
    spaceId: spacesResourceIdSchema,
    href: z.string(),
    outcome: z.enum(["created", "updated", "unchanged", "cancelled"]),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.href !== canonicalSpacesItemHref(value.spaceId, value.itemId)) {
      context.addIssue({ code: "custom", path: ["href"], message: "href must match the Space and item IDs" });
    }
  });
export type CalendarInvitationImportResult = z.infer<typeof calendarInvitationImportResultSchema>;

export const calendarInvitationResponseSchema = z
  .object({
    to: calendarAddressSchema,
    subject: z.string().min(1).max(998),
    body: z.string().max(20_000),
    calendar: z
      .string()
      .min(1)
      .max(96 * 1024),
  })
  .passthrough();
export const calendarResponseStateDataSchema = calendarResponseStateSchema;

export const spacesMailDestinationSchema = z
  .object({ id: spacesResourceIdSchema, name: z.string().min(1).max(100), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) })
  .passthrough();
export const spacesMailDestinationsSchema = z.array(spacesMailDestinationSchema).max(500);
export const spacesMailDestinationContextSchema = z
  .object({ selectedSpaceId: spacesResourceIdSchema.nullable(), items: spacesMailDestinationsSchema })
  .passthrough();
export type SpacesMailDestinationContext = z.infer<typeof spacesMailDestinationContextSchema>;

export const spacesItemSearchDataSchema = z.array(CloudResourceViewSchema).max(100);
export const spacesItemReferenceFindDataSchema = z.object({ items: spacesItemSearchDataSchema, truncated: z.boolean() }).strict();
export const spacesItemResourceReferenceSchema = z
  .object({ ref: CloudResourceRefSchema, label: z.string().trim().min(1).max(500), createdAt: timestampSchema })
  .strict();
export const spacesItemReferenceRemoveDataSchema = z
  .object({ itemId: spacesResourceIdSchema, ref: CloudResourceRefSchema, deleted: z.boolean() })
  .strict();
export const spacesItemMutationDataSchema = z
  .object({ kind: z.enum(["task", "event"]), id: spacesResourceIdSchema, spaceId: spacesResourceIdSchema, title: z.string().min(1) })
  .passthrough();

const spaceColumnSchema = z
  .object({ id: spacesResourceIdSchema, name: z.string().min(1), color: nullableTextSchema, isDone: z.boolean() })
  .passthrough();
export const spaceDetailSchema = z
  .object({
    id: spacesResourceIdSchema,
    name: z.string().min(1),
    description: nullableTextSchema,
    color: z.string().min(1),
    permission: z.enum(["read", "write", "admin"]),
    columns: z.array(spaceColumnSchema).max(100),
    columnsTruncated: z.boolean(),
  })
  .passthrough();

export const calendarEventSchema = z
  .object({
    kind: z.literal("event"),
    id: spacesResourceIdSchema,
    spaceId: spacesResourceIdSchema,
    columnId: spacesResourceIdSchema,
    title: z.string().min(1),
    location: nullableTextSchema,
    startsAt: timestampSchema,
    endsAt: timestampSchema,
    allDay: z.boolean(),
  })
  .passthrough();
export const calendarEventsSchema = z.array(calendarEventSchema).max(100);
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

export const eventInvitationPrepareDataSchema = z
  .object({
    deliveryId: z.uuid(),
    itemId: spacesResourceIdSchema,
    mailboxId: mailResourceIdSchema,
    draftId: mailResourceIdSchema,
    sequence: z.number().int().nonnegative(),
    filename: z.string().min(1).max(255),
    contentType: z.string().min(1).max(255),
    calendar: z
      .string()
      .min(1)
      .max(96 * 1024),
  })
  .passthrough();
export const eventInvitationCommitDataSchema = z
  .object({ deliveryId: z.uuid(), itemId: spacesResourceIdSchema, draftId: mailResourceIdSchema, state: z.literal("drafted") })
  .passthrough();
