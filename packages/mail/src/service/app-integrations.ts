import { getCapabilityCatalogApp, invokeCapabilityWithDataSchema } from "@valentinkolb/cloud/capabilities/server";
import type { CapabilityResult } from "@valentinkolb/cloud/contracts";
import type { z } from "zod";
import {
  type CalendarAddress,
  type CalendarParticipationStatus,
  calendarEventSchema,
  calendarEventsSchema,
  calendarInvitationImportResultSchema,
  calendarInvitationPreviewSchema,
  calendarInvitationResponseSchema,
  calendarResponseStateDataSchema,
  contactOpenHref,
  contactResolveDataSchema,
  eventInvitationCommitDataSchema,
  eventInvitationPrepareDataSchema,
  spaceDetailSchema,
  spacesItemMutationDataSchema,
  spacesItemReferenceFindDataSchema,
  spacesItemReferenceRemoveDataSchema,
  spacesItemResourceReferenceSchema,
  spacesItemSearchDataSchema,
  spacesMailDestinationsSchema,
} from "../app-integration-contracts";

const REQUIRED_SPACES_INVITATION_QUERIES = [
  "calendar-destination.list",
  "calendar-invitation.preview",
  "calendar-invitation.response.prepare",
] as const;
const REQUIRED_SPACES_INVITATION_ACTIONS = ["calendar-invitation.import", "calendar-invitation.response.commit"] as const;
const REQUIRED_SPACES_SETTINGS_QUERIES = ["calendar-destination.list"] as const;
const REQUIRED_SPACES_COMPOSER_QUERIES = ["calendar-destination.list", "space.read", "event.list"] as const;
const REQUIRED_SPACES_COMPOSER_ACTIONS = ["event.create", "event.invitation.prepare", "event.invitation.commit"] as const;
const REQUIRED_SPACES_CONTEXT_QUERIES = [
  "item.reference.find",
  "item.link-candidate.search",
  "space.read",
  "calendar-destination.list",
] as const;
const REQUIRED_SPACES_CONTEXT_ACTIONS = [
  "item.reference.add",
  "item.reference.remove",
  "task.create",
  "event.create",
  "event.create-once",
] as const;

export type AppIntegrationRequest = {
  cookie?: string | null;
  authorization?: string | null;
  requestId?: string | null;
  traceparent?: string | null;
  tracestate?: string | null;
  signal?: AbortSignal;
};

export type AppIntegrationFailure = { ok: false; code: string; message: string; status: number };
type AppIntegrationResult<T> = { ok: true; data: T } | AppIntegrationFailure;
type CapabilityFailure = { code: string; message: string; status: number };

export const getSpacesMailIntegrationAvailability = async (): Promise<{
  invitations: boolean;
  settings: boolean;
  composer: boolean;
  context: boolean;
}> => {
  try {
    const catalog = await getCapabilityCatalogApp("spaces");
    if (!catalog.ok || !catalog.data) return { invitations: false, settings: false, composer: false, context: false };
    const queries = new Set(catalog.data.manifest.queries.map((operation) => operation.localId));
    const actions = new Set(catalog.data.manifest.actions.map((operation) => operation.localId));
    const invitations =
      REQUIRED_SPACES_INVITATION_QUERIES.every((id) => queries.has(id)) &&
      REQUIRED_SPACES_INVITATION_ACTIONS.every((id) => actions.has(id));
    return {
      invitations,
      settings: REQUIRED_SPACES_SETTINGS_QUERIES.every((id) => queries.has(id)),
      composer:
        REQUIRED_SPACES_COMPOSER_QUERIES.every((id) => queries.has(id)) && REQUIRED_SPACES_COMPOSER_ACTIONS.every((id) => actions.has(id)),
      context:
        REQUIRED_SPACES_CONTEXT_QUERIES.every((id) => queries.has(id)) && REQUIRED_SPACES_CONTEXT_ACTIONS.every((id) => actions.has(id)),
    };
  } catch {
    return { invitations: false, settings: false, composer: false, context: false };
  }
};

export const findSpaceItemsByResource = (ref: { type: string; id: string }, request: AppIntegrationRequest) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "query",
    capabilityId: "item.reference.find",
    request,
    dataSchema: spacesItemReferenceFindDataSchema,
    input: { ref, limit: 50 },
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));

export const searchSpaceItems = (query: string, request: AppIntegrationRequest) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "query",
    capabilityId: "item.link-candidate.search",
    request,
    dataSchema: spacesItemSearchDataSchema,
    input: { query, limit: 50 },
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));

export const linkSpaceItemResource = (
  input: { itemId: string; reference: { ref: { type: string; id: string }; label: string } },
  request: AppIntegrationRequest,
) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "action",
    capabilityId: "item.reference.add",
    request,
    dataSchema: spacesItemResourceReferenceSchema,
    input,
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));

export const createSpaceEventOnce = (input: Record<string, unknown>, idempotencyKey: string, request: AppIntegrationRequest) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "action",
    capabilityId: "event.create-once",
    request,
    dataSchema: spacesItemMutationDataSchema,
    input,
    idempotencyKey,
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));

export const unlinkSpaceItemResource = (input: { itemId: string; ref: { type: string; id: string } }, request: AppIntegrationRequest) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "action",
    capabilityId: "item.reference.remove",
    request,
    dataSchema: spacesItemReferenceRemoveDataSchema,
    input,
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));

export const createSpaceItemForResource = (kind: "task" | "event", input: Record<string, unknown>, request: AppIntegrationRequest) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "action",
    capabilityId: `${kind}.create`,
    request,
    dataSchema: spacesItemMutationDataSchema,
    input,
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));

export const projectAppCapabilityError = (error: CapabilityFailure): AppIntegrationFailure => {
  const unavailable =
    error.code === "APP_UNAVAILABLE" ||
    error.code === "CAPABILITY_NOT_FOUND" ||
    error.code === "INVALID_APP_RESPONSE" ||
    error.status === 502 ||
    error.status === 503;
  return {
    ok: false,
    code: error.code,
    message: error.message,
    status: unavailable && error.status < 500 ? 503 : error.status,
  };
};

const fetchAppCapability = async <T>(params: {
  appId: string;
  kind: "query" | "action";
  capabilityId: string;
  request: AppIntegrationRequest;
  dataSchema: z.ZodType<T>;
  input: unknown;
  idempotencyKey?: string;
}): Promise<AppIntegrationResult<CapabilityResult<T>>> => {
  const result = await invokeCapabilityWithDataSchema(
    {
      appId: params.appId,
      capabilityId: params.capabilityId,
      kind: params.kind,
      input: params.input,
      idempotencyKey: params.idempotencyKey,
    },
    params.dataSchema,
    params.request,
  );
  if (!result.ok) return projectAppCapabilityError(result.error);
  return { ok: true, data: result.data };
};

export const resolveContacts = async (
  input: { emails: string[]; contactIds?: string[]; cursor?: string; limit?: number },
  request: AppIntegrationRequest,
) => {
  const result = await fetchAppCapability({
    appId: "contacts",
    kind: "query",
    capabilityId: "contact.resolve",
    request,
    dataSchema: contactResolveDataSchema,
    input,
  });
  if (!result.ok) return result;
  return {
    ok: true as const,
    data: {
      ...result.data.data,
      items: result.data.data.items.map((item) => ({
        ...item,
        openHref: contactOpenHref(item.links),
      })),
      nextCursor: result.data.page?.hasMore ? result.data.page.nextCursor : null,
    },
  };
};

export const listCalendarDestinations = (request: AppIntegrationRequest) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "query",
    capabilityId: "calendar-destination.list",
    request,
    dataSchema: spacesMailDestinationsSchema,
    input: {},
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));

export const getCalendarSpace = (spaceId: string, request: AppIntegrationRequest) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "query",
    capabilityId: "space.read",
    request,
    dataSchema: spaceDetailSchema,
    input: { id: spaceId },
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));

export const listCalendarEvents = (spaceId: string, request: AppIntegrationRequest, query?: string) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "query",
    capabilityId: "event.list",
    request,
    dataSchema: calendarEventsSchema,
    input: {
      spaceId,
      query: query?.trim() || undefined,
      status: "active",
      assignedTo: "all",
      sort: "updated",
      sortDesc: true,
      limit: 100,
    },
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));

export const createCalendarEvent = (
  input: {
    spaceId: string;
    columnId: string;
    title: string;
    location?: string;
    startsAt: string;
    endsAt: string;
    allDay?: boolean;
  },
  request: AppIntegrationRequest,
) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "action",
    capabilityId: "event.create",
    request,
    dataSchema: calendarEventSchema,
    input,
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));

export const prepareEventInvitation = (
  input: {
    itemId: string;
    mailboxId: string;
    draftId: string;
    senderIdentityId: string;
    organizer: CalendarAddress;
    attendees: CalendarAddress[];
  },
  request: AppIntegrationRequest,
  idempotencyKey: string,
) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "action",
    capabilityId: "event.invitation.prepare",
    request,
    dataSchema: eventInvitationPrepareDataSchema,
    input,
    idempotencyKey,
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));

export const commitEventInvitation = (input: { deliveryId: string }, request: AppIntegrationRequest) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "action",
    capabilityId: "event.invitation.commit",
    request,
    dataSchema: eventInvitationCommitDataSchema,
    input,
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));

export const previewCalendarInvitation = (
  input: { mailboxId: string; messageId: string; calendar: string },
  request: AppIntegrationRequest,
) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "query",
    capabilityId: "calendar-invitation.preview",
    request,
    dataSchema: calendarInvitationPreviewSchema,
    input,
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));

export const importCalendarInvitation = (
  input: {
    mailboxId: string;
    messageId: string;
    calendar: string;
    spaceId: string;
    conversation: { ref: { type: "mail.conversation"; id: string }; label: string };
  },
  request: AppIntegrationRequest,
) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "action",
    capabilityId: "calendar-invitation.import",
    request,
    dataSchema: calendarInvitationImportResultSchema,
    input,
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));

export const buildCalendarInvitationResponse = (
  input: {
    mailboxId: string;
    messageId: string;
    calendar: string;
    attendee: CalendarAddress;
    participationStatus: CalendarParticipationStatus;
  },
  request: AppIntegrationRequest,
) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "query",
    capabilityId: "calendar-invitation.response.prepare",
    request,
    dataSchema: calendarInvitationResponseSchema,
    input,
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));

export const commitCalendarInvitationResponse = (
  input: { mailboxId: string; messageId: string; participationStatus: CalendarParticipationStatus; draftId: string },
  request: AppIntegrationRequest,
) =>
  fetchAppCapability({
    appId: "spaces",
    kind: "action",
    capabilityId: "calendar-invitation.response.commit",
    request,
    dataSchema: calendarResponseStateDataSchema,
    input,
  }).then((result) => (result.ok ? { ok: true as const, data: result.data.data } : result));
