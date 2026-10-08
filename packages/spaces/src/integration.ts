import { z } from "zod";
import { ResourceShortIdSchema } from "./contracts";
import { buildSpaceItemHref } from "./routes";

export const MAX_PREPARED_EVENT_INVITATION_CALENDAR_LENGTH = 96 * 1024;

const CalendarInvitationExistingSchema = z
  .object({
    itemId: ResourceShortIdSchema,
    spaceId: ResourceShortIdSchema,
    href: z.string(),
    sequence: z.number().int().nonnegative(),
    method: z.enum(["request", "cancel", "reply", "publish", "unknown"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.href !== buildSpaceItemHref(value.spaceId, value.itemId)) {
      context.addIssue({ code: "custom", path: ["href"], message: "href must match the Space and item IDs" });
    }
  });

const CalendarInvitationImportResultObjectSchema = z
  .object({
    itemId: ResourceShortIdSchema,
    spaceId: ResourceShortIdSchema,
    href: z.string(),
    outcome: z.enum(["created", "updated", "unchanged", "cancelled"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.href !== buildSpaceItemHref(value.spaceId, value.itemId)) {
      context.addIssue({ code: "custom", path: ["href"], message: "href must match the Space and item IDs" });
    }
  });

export const CalendarAddressSchema = z
  .object({
    name: z.string().max(500).nullable().describe("Optional calendar participant display name."),
    address: z.string().email().max(320).describe("Calendar participant email address."),
  })
  .strict();
export type CalendarAddress = z.infer<typeof CalendarAddressSchema>;

export const CalendarAttendeeSchema = CalendarAddressSchema.extend({
  participationStatus: z.enum(["needs_action", "accepted", "tentative", "declined", "delegated", "unknown"]),
  role: z.enum(["required", "optional", "chair", "unknown"]),
  responseRequested: z.boolean(),
}).strict();
export type CalendarAttendee = z.infer<typeof CalendarAttendeeSchema>;

export const CalendarInvitationSourceSchema = z
  .object({
    mailboxId: ResourceShortIdSchema,
    messageId: ResourceShortIdSchema,
  })
  .strict();

export const CalendarInvitationPreviewInputSchema = CalendarInvitationSourceSchema.extend({
  calendar: z.string().min(1).max(1_000_000),
}).strict();
export type CalendarInvitationPreviewInput = z.infer<typeof CalendarInvitationPreviewInputSchema>;

export const CalendarInvitationSchema = z
  .object({
    method: z.enum(["request", "cancel", "reply", "publish", "unknown"]),
    uid: z.string().min(1).max(1024),
    sequence: z.number().int().nonnegative(),
    status: z.enum(["confirmed", "tentative", "cancelled", "unknown"]),
    title: z.string().min(1).max(200),
    description: z.string().max(5000).nullable(),
    location: z.string().max(500).nullable(),
    url: z.string().url().max(2000).nullable(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    allDay: z.boolean(),
    recurrenceRule: z.string().max(4096).nullable(),
    organizer: CalendarAddressSchema.nullable(),
    attendees: z.array(CalendarAttendeeSchema).max(500),
  })
  .strict();
export type CalendarInvitation = z.infer<typeof CalendarInvitationSchema>;

export const CalendarInvitationPreviewSchema = z
  .object({
    invitation: CalendarInvitationSchema,
    response: z
      .object({
        participationStatus: z.enum(["accepted", "tentative", "declined"]),
        state: z.literal("drafted"),
        draftId: ResourceShortIdSchema,
        updatedAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
    existing: CalendarInvitationExistingSchema.nullable(),
  })
  .strict();
export type CalendarInvitationPreview = z.infer<typeof CalendarInvitationPreviewSchema>;

export const CalendarInvitationImportInputSchema = CalendarInvitationPreviewInputSchema.extend({
  spaceId: ResourceShortIdSchema,
}).strict();
export type CalendarInvitationImportInput = z.infer<typeof CalendarInvitationImportInputSchema>;

export const CalendarInvitationImportResultSchema = CalendarInvitationImportResultObjectSchema;
export type CalendarInvitationImportResult = z.infer<typeof CalendarInvitationImportResultSchema>;

export const CalendarParticipationStatusSchema = z.enum(["accepted", "tentative", "declined"]);
export type CalendarParticipationStatus = z.infer<typeof CalendarParticipationStatusSchema>;

export const CalendarInvitationResponseInputSchema = CalendarInvitationPreviewInputSchema.extend({
  attendee: CalendarAddressSchema,
  participationStatus: CalendarParticipationStatusSchema,
}).strict();
export type CalendarInvitationResponseInput = z.infer<typeof CalendarInvitationResponseInputSchema>;

export const CalendarInvitationResponseSchema = z
  .object({
    to: CalendarAddressSchema,
    subject: z.string().min(1).max(998),
    body: z.string().max(20_000),
    calendar: z.string().min(1).max(1_000_000),
  })
  .strict();
export type CalendarInvitationResponse = z.infer<typeof CalendarInvitationResponseSchema>;

export const CalendarInvitationResponseCommitInputSchema = CalendarInvitationSourceSchema.extend({
  participationStatus: CalendarParticipationStatusSchema,
  draftId: ResourceShortIdSchema,
}).strict();
export type CalendarInvitationResponseCommitInput = z.infer<typeof CalendarInvitationResponseCommitInputSchema>;

export const CalendarInvitationResponseStateSchema = CalendarInvitationPreviewSchema.shape.response.unwrap();
export type CalendarInvitationResponseState = z.infer<typeof CalendarInvitationResponseStateSchema>;

export const SpacesMailDestinationSchema = z
  .object({
    id: ResourceShortIdSchema,
    name: z.string().min(1).max(100),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .strict();
export type SpacesMailDestination = z.infer<typeof SpacesMailDestinationSchema>;

export const SpacesMailDestinationsSchema = z.array(SpacesMailDestinationSchema).max(500);

export const SpacesMailDestinationContextSchema = z
  .object({
    selectedSpaceId: ResourceShortIdSchema.nullable(),
    items: SpacesMailDestinationsSchema,
  })
  .strict();
export type SpacesMailDestinationContext = z.infer<typeof SpacesMailDestinationContextSchema>;

export const MailInvitationMailboxSchema = z
  .object({
    id: ResourceShortIdSchema,
    name: z.string().min(1).max(160),
    identities: z
      .array(
        z
          .object({
            id: ResourceShortIdSchema,
            label: z.string().min(1).max(160),
            from: CalendarAddressSchema,
            isDefault: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const MailInvitationMailboxesSchema = z.array(MailInvitationMailboxSchema).max(200);
export type MailInvitationMailbox = z.infer<typeof MailInvitationMailboxSchema>;

export const CreateEventInvitationDraftInputSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    mailboxId: ResourceShortIdSchema,
    senderIdentityId: ResourceShortIdSchema,
    attendees: z.array(CalendarAddressSchema).min(1).max(200),
    method: z.enum(["request", "cancel"]).default("request"),
  })
  .strict();
export type CreateEventInvitationDraftInput = z.infer<typeof CreateEventInvitationDraftInputSchema>;

export const EventInvitationContextSchema = z
  .object({
    mailboxes: MailInvitationMailboxesSchema,
    attendees: z.array(CalendarAddressSchema).max(200),
    canCancel: z.boolean(),
    lastDelivery: z
      .object({
        sequence: z.number().int().nonnegative(),
        method: z.enum(["request", "cancel"]),
        state: z.enum(["preparing", "prepared", "drafted", "failed"]),
        draftId: ResourceShortIdSchema.nullable(),
        errorMessage: z.string().max(2_000).nullable(),
        updatedAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type EventInvitationContext = z.infer<typeof EventInvitationContextSchema>;

export const MailEventInvitationDraftInputSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    mailboxId: ResourceShortIdSchema,
    senderIdentityId: ResourceShortIdSchema,
    to: z.array(CalendarAddressSchema).min(1).max(200),
    subject: z.string().min(1).max(998),
    body: z.string().max(20_000),
    calendar: z.string().min(1).max(1_000_000),
  })
  .strict();
export type MailEventInvitationDraftInput = z.infer<typeof MailEventInvitationDraftInputSchema>;

export const MailEventInvitationDraftSchema = z
  .object({
    mailboxId: ResourceShortIdSchema,
    draftId: ResourceShortIdSchema,
  })
  .strict();
export type MailEventInvitationDraft = z.infer<typeof MailEventInvitationDraftSchema>;

export const EventInvitationDraftSchema = MailEventInvitationDraftSchema.extend({
  href: z.string().startsWith("/app/mail/"),
  sequence: z.number().int().nonnegative(),
  method: z.enum(["request", "cancel"]),
}).strict();
export type EventInvitationDraft = z.infer<typeof EventInvitationDraftSchema>;
