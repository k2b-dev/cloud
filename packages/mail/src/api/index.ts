import { Readable } from "node:stream";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { ErrorResponseSchema, GrantAccessSchema, UpdateAccessSchema } from "@valentinkolb/cloud/contracts";
import { auth, jsonResponse, rateLimit, requiresAuth, respond, v } from "@valentinkolb/cloud/server";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  calendarEventSchema,
  calendarEventsSchema,
  calendarInvitationImportResultSchema,
  calendarInvitationPreviewSchema,
  calendarParticipationStatusSchema,
  spaceDetailSchema,
  spacesItemMutationDataSchema,
  spacesItemReferenceRemoveDataSchema,
  spacesItemResourceReferenceSchema,
  spacesItemSearchDataSchema,
  spacesMailDestinationsSchema,
} from "../app-integration-contracts";
import { attachmentPreviewKind, attachmentPreviewSignatureMatches, baseAttachmentContentType } from "../attachment-preview-policy";
import {
  type AttachmentLink,
  type AttachmentLinkPage,
  archiveComposeTemplateInputSchema,
  automaticReplyManagementPermissionSchema,
  cancelConversationReminderSchema,
  cancelScheduledSendInputSchema,
  composePreviewInputSchema,
  composeSafetyConfigSchema,
  composeSafetyReviewInputSchema,
  composeSuggestionsInputSchema,
  configurableFolderRoleSchema,
  conversationPresenceHeartbeatSchema,
  conversationPresenceLeaveSchema,
  conversationTriageInputSchema,
  conversationViewSchema,
  createAttachmentLinkInputSchema,
  createComposeTemplateInputSchema,
  createConversationCommentSchema,
  createDeliveryRecoveryDraftInputSchema,
  createDraftAttachmentUploadSchema,
  createMailboxInputSchema,
  createSavedConversationViewSchema,
  createSenderIdentityInputSchema,
  defaultSenderSetupInputSchema,
  deleteConversationCommentSchema,
  deleteSavedConversationViewSchema,
  deleteSenderIdentityTransportInputSchema,
  deriveDraftFromMessageInputSchema,
  draftContentInputSchema,
  draftEditableContentInputSchema,
  draftLeaseTokenSchema,
  draftSchema,
  type MailCommand,
  type MailCommandInput,
  mailCommandInputSchema,
  mailConversationContextQuerySchema,
  mailConversationContextSchema,
  mailConversationSpaceCreateInputSchema,
  mailConversationSpaceLinkInputSchema,
  mailConversationSpaceSearchQuerySchema,
  mailFocusPageSchema,
  mailFocusViewSchema,
  mailingListDispositionInputSchema,
  maintenanceCommandInputSchema,
  materializeDraftSeedInputSchema,
  mergeConversationsInputSchema,
  prepareDraftSeedInputSchema,
  providerConnectionInputSchema,
  ResourceShortIdSchema,
  reassignConversationMessageInputSchema,
  relatedConversationListSchema,
  relatedConversationQuerySchema,
  relatedMailPageSchema,
  relatedMailQuerySchema,
  renderComposeSnippetInputSchema,
  searchBackendSchema,
  searchRequestSchema,
  setComposeSignatureDefaultInputSchema,
  setConversationReminderSchema,
  splitConversationInputSchema,
  unsubscribeMailingListInputSchema,
  updateComposeTemplateInputSchema,
  updateConversationCollaborationSchema,
  updateConversationCommentSchema,
  updateConversationSummarySchema,
  updateMailboxComposeStyleInputSchema,
  updateSavedConversationViewSchema,
  updateSenderIdentityInputSchema,
  updateSenderIdentityTransportInputSchema,
} from "../contracts";
import {
  createMailProtectedIdentityInputSchema,
  createMailSecurityPolicyInputSchema,
  mailSecurityListQuerySchema,
  resolveMailSecurityReportInputSchema,
  updateMailSecurityPolicyInputSchema,
  updateMailSecuritySettingsInputSchema,
} from "../security-contracts";
import {
  attachmentLinks,
  bindings,
  calendarInvitations,
  cancelSendCommand,
  collaboration,
  commands,
  composeSafety,
  composeTemplates,
  conversationContext,
  conversationSummaries,
  conversations,
  draftLeases,
  drafts,
  draftUploads,
  focus,
  folders,
  health,
  listSubscriptions,
  type MailRequestContext,
  mailboxAccess,
  mailboxes,
  messageInspector,
  messages,
  notificationTargets,
  operations,
  presence,
  providerConnections,
  publicResources,
  reminders,
  savedViews,
  scheduledSends,
  search,
  security,
  senderIdentities,
  senderIdentityTransports,
  settingsContext,
  storageObservability,
  triage,
} from "../service";
import { resolveByteRange } from "../service/byte-range";
import type { AttachmentDownload } from "../service/messages";
import { discoverMailConfigurations } from "../service/onboarding-discovery";
import { loadMailboxConversationDetail, loadMailboxPageData } from "../service/workspace";
import wsRoutes from "../ws";
import { projectActivityResult } from "./activity-public";
import { providerOAuthApi } from "./provider-oauth";
import {
  internalInput,
  internalMailboxId,
  internalParams,
  type MailApiContext,
  mailboxParamSchema,
  projectResourcePaths,
  projectRootRelation,
  resolveMailboxParam,
  resolveMailboxResourceParam,
  resolveReminderNotificationSourceParam,
  respondPublic,
} from "./public-resource-boundary";
import resourceRoutes from "./resources";
import workflowRoutes from "./workflows";

const mailboxAndIdParamSchema = (name: string, idSchema: z.ZodType = ResourceShortIdSchema) =>
  z.object({ mailboxId: ResourceShortIdSchema, [name]: idSchema });
const mailboxAndTwoIdsParamSchema = (first: string, second: string) =>
  z.object({ mailboxId: ResourceShortIdSchema, [first]: ResourceShortIdSchema, [second]: ResourceShortIdSchema });
const limitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const mailboxListQuerySchema = limitQuerySchema.extend({
  name: z.string().trim().min(1).max(160).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});
const conversationDraftsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const cursorQuerySchema = z.object({
  cursor: z.string().max(2_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const conversationCommentsQuerySchema = cursorQuerySchema.extend({
  order: z.enum(["oldest", "newest"]).default("oldest"),
});
const conversationMessagesQuerySchema = cursorQuerySchema.extend({
  latest: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
const subscriptionQuerySchema = cursorQuerySchema.extend({
  listKey: z.string().trim().toLowerCase().min(1).max(4096).optional(),
});
const platformOperationsQuerySchema = z.object({
  cursor: z.string().max(2_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(200).optional(),
});
const mailboxOperationsQuerySchema = z.object({
  attentionCursor: z.string().max(2_000).optional(),
  attentionLimit: z.coerce.number().int().min(1).max(200).default(100),
});
const conversationQuerySchema = cursorQuerySchema.extend({
  folderId: ResourceShortIdSchema.optional(),
  status: z.enum(["needs_action", "waiting", "done"]).optional(),
  view: conversationViewSchema.optional(),
});
const mailFocusQuerySchema = cursorQuerySchema.extend({
  view: mailFocusViewSchema.default("mine"),
});
const collaboratorQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const activityQuerySchema = cursorQuerySchema.extend({
  conversationId: ResourceShortIdSchema.optional(),
});
const workspaceRouteQuerySchema = z.object({
  href: z.string().trim().min(1).max(4_000),
  listMode: z.enum(["conversations", "messages"]).default("conversations"),
});
const attachmentQuerySchema = z.object({
  inline: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  length: z.coerce
    .number()
    .int()
    .min(1)
    .max(4 * 1024 * 1024)
    .optional(),
});
const messageSourceQuerySchema = z.object({
  offset: z.coerce.number().int().nonnegative().optional(),
  length: z.coerce
    .number()
    .int()
    .min(1)
    .max(4 * 1024 * 1024)
    .optional(),
});
const updateMailboxSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2_000).nullable().optional(),
    syncEnabled: z.boolean().optional(),
    searchBackend: searchBackendSchema.optional(),
    automaticReplyManagementPermission: automaticReplyManagementPermissionSchema.optional(),
    composeSafety: composeSafetyConfigSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");
const calendarDestinationInputSchema = z.object({ spaceId: ResourceShortIdSchema.nullable() }).strict();
const calendarDestinationsResponseSchema = z.object({
  selectedSpaceId: ResourceShortIdSchema.nullable(),
  items: spacesMailDestinationsSchema,
});
const calendarImportInputSchema = z.object({ spaceId: ResourceShortIdSchema.optional() }).strict();
const calendarEventsQuerySchema = z.object({ spaceId: ResourceShortIdSchema, query: z.string().trim().max(500).optional() }).strict();
const createCalendarEventInputSchema = z
  .object({
    spaceId: ResourceShortIdSchema,
    title: z.string().trim().min(1).max(200),
    location: z.string().trim().max(500).optional(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((value) => new Date(value.endsAt) > new Date(value.startsAt), {
    message: "End time must be after start time",
    path: ["endsAt"],
  });
const attachCalendarEventInputSchema = z.object({ itemId: ResourceShortIdSchema, idempotencyKey: z.uuid() }).strict();
const calendarResponseInputSchema = z
  .object({
    participationStatus: calendarParticipationStatusSchema,
    idempotencyKey: z.string().uuid(),
    spaceId: ResourceShortIdSchema.optional(),
  })
  .strict();
const attachBindingSchema = z.object({ connectionId: z.string().uuid() });
const verifyIdentitySchema = z.object({
  bindingId: z.string().uuid(),
  verificationRecipient: z.string().email().max(320),
  savesSentAutomatically: z.boolean(),
});
const updateDraftSchema = z.object({
  expectedRevision: z.number().int().positive(),
  draft: draftEditableContentInputSchema,
});
const roleParamSchema = z.object({
  mailboxId: ResourceShortIdSchema,
  role: configurableFolderRoleSchema,
});
const folderRoleInputSchema = z.object({ folderId: ResourceShortIdSchema });
const folderVisibilityInputSchema = z.object({ showInSidebar: z.boolean() }).strict();
const draftRevisionSchema = z.object({
  expectedRevision: z.coerce.number().int().positive(),
});
const draftRecoveryRestoreSchema = draftRevisionSchema.extend({
  leaseToken: z.string().uuid(),
});
const attachmentUploadQuerySchema = draftRevisionSchema.extend({
  filename: z.string().trim().min(1).max(255),
});
const attachmentChunkQuerySchema = z.object({
  offset: z.coerce.number().int().nonnegative(),
});
const acquireDraftLeaseSchema = z.object({ takeover: z.boolean().default(false) }).strict();
const notificationTargetParamSchema = z.object({
  mailboxId: ResourceShortIdSchema,
  kind: z.literal("reminder"),
  sourceId: ResourceShortIdSchema,
});
const providerDiscoveryQuerySchema = z.object({
  email: z.string().email().max(320),
});

const parseWorkspaceRouteUrl = async (publicMailboxId: string, internalMailboxId: string, href: string): Promise<URL | null> => {
  try {
    const base = new URL("https://cloud.invalid");
    const url = new URL(href, base);
    if (url.origin !== base.origin || url.pathname !== `/app/mail/${publicMailboxId}`) return null;
    const resourceParams = [
      ["savedView", "savedViews"],
      ["folder", "folders"],
      ["conversation", "conversations"],
      ["message", "messages"],
    ] as const;
    for (const [name, table] of resourceParams) {
      const publicId = url.searchParams.get(name);
      if (publicId === null) continue;
      if (!ResourceShortIdSchema.safeParse(publicId).success) return null;
      const resolved = await publicResources.resolveMailboxPublicId(table, internalMailboxId, publicId);
      if (!resolved) return null;
      url.searchParams.set(name, resolved);
    }
    return url;
  } catch {
    return null;
  }
};

const attachmentContentDisposition = (value: string | null, inline: boolean): string => {
  const filename = [...(value?.normalize("NFC") || "attachment")].slice(0, 255).join("");
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_") || "attachment";
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

const safeAttachmentContentType = (value: string): string =>
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(baseAttachmentContentType(value))
    ? baseAttachmentContentType(value)
    : "application/octet-stream";

const requestContext = (c: Context<MailApiContext>): MailRequestContext => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  requestId: c.req.header("x-request-id") ?? null,
});

const integrationRequest = (c: Context<MailApiContext>) => ({
  cookie: c.req.header("Cookie"),
  authorization: c.req.header("Authorization"),
  requestId: c.req.header("X-Request-Id") ?? requestContext(c).requestId,
  traceparent: c.req.header("traceparent"),
  tracestate: c.req.header("tracestate"),
  signal: c.req.raw.signal,
});

const respondMailboxes = <T>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) => respondPublic(c, result, "mailboxes");
const respondAppDependency = <T>(
  c: Context<MailApiContext>,
  result: Result<T> | { ok: false; code: string; message: string; status: 503 },
) =>
  !result.ok && "message" in result
    ? respond(c, { ok: false, error: result.message, code: result.code, status: result.status })
    : respondPublic(c, result);
const respondFolders = async <T>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) =>
  respondPublic(c, await projectRootRelation(await result, "parentId", "folders"), "folders");
const respondConversations = <T>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) =>
  respondPublic(c, result, "conversations");
const respondFocus = async <T extends { items: Array<{ id: string; mailboxId: string }>; mailboxCounts: Array<{ mailboxId: string }> }>(
  c: Context<MailApiContext>,
  result: Result<T> | Promise<Result<T>>,
) => {
  const resolved = await result;
  if (!resolved.ok) return respondPublic(c, resolved);
  const paths = resolved.data.items.flatMap((_item, index) => [
    { path: ["items", String(index), "id"], table: "conversations" as const },
    { path: ["items", String(index), "mailboxId"], table: "mailboxes" as const },
  ]);
  resolved.data.mailboxCounts.forEach((_counts, index) => {
    paths.push({ path: ["mailboxCounts", String(index), "mailboxId"], table: "mailboxes" as const });
  });
  return respondPublic(c, await projectResourcePaths(resolved, paths));
};
const respondMessages = async <T>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) => {
  const resolved = await result;
  if (!resolved.ok) return respondPublic(c, resolved);
  const data = resolved.data as unknown;
  const items = Array.isArray(data)
    ? data
    : data && typeof data === "object" && "items" in data && Array.isArray(data.items)
      ? data.items
      : [data];
  const deliveryPaths = items.flatMap((item, index) => {
    if (!item || typeof item !== "object" || !("delivery" in item) || !item.delivery) return [];
    const prefix = Array.isArray(data)
      ? [String(index)]
      : data && typeof data === "object" && "items" in data
        ? ["items", String(index)]
        : [];
    return [{ path: [...prefix, "delivery", "submissionId"], table: "deliveries" as const }];
  });
  const attachmentMatchPaths = items.flatMap((item, index) => {
    if (!item || typeof item !== "object" || !("attachmentMatch" in item) || !item.attachmentMatch) return [];
    const prefix = Array.isArray(data)
      ? [String(index)]
      : data && typeof data === "object" && "items" in data
        ? ["items", String(index)]
        : [];
    return [
      { path: [...prefix, "attachmentMatch", "attachmentId"], table: "attachments" as const },
      { path: [...prefix, "attachmentMatch", "messageId"], table: "messages" as const },
    ];
  });
  return respondPublic(c, await projectResourcePaths(resolved, [...deliveryPaths, ...attachmentMatchPaths]), "messages");
};
const respondComments = <T>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) => respondPublic(c, result, "comments");
const respondReminders = <T>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) => respondPublic(c, result, "reminders");
const respondSavedViews = <T>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) => respondPublic(c, result, "savedViews");
const respondComposeTemplates = <T>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) =>
  respondPublic(c, result, "composeTemplates");
const respondSenderIdentities = <T>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) =>
  respondPublic(c, result, "senderIdentities");
const respondDrafts = <T>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) => respondPublic(c, result, "drafts");
const respondDeliveries = <T>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) => respondPublic(c, result, "deliveries");
const projectAttachmentLinks = async <T extends AttachmentLink | { link: AttachmentLink } | AttachmentLinkPage>(
  result: Result<T> | Promise<Result<T>>,
): Promise<Result<T>> => {
  const resolved = await result;
  if (!resolved.ok) return resolved;
  const pathsFor = (link: AttachmentLink, item: string[]) => {
    return [
      { path: [...item, "mailboxId"], table: "mailboxes" as const },
      { path: [...item, "sourceId"], table: link.sourceKind === "message" ? ("messages" as const) : ("drafts" as const) },
    ];
  };
  const paths =
    "items" in resolved.data
      ? resolved.data.items.flatMap((link, index) => pathsFor(link, ["items", String(index)]))
      : "link" in resolved.data
        ? pathsFor(resolved.data.link, ["link"])
        : pathsFor(resolved.data, []);
  return projectResourcePaths(resolved, paths);
};
const projectCommands = async <T extends MailCommand | MailCommand[]>(result: Result<T> | Promise<Result<T>>): Promise<Result<T>> => {
  const resolved = await result;
  if (!resolved.ok) return resolved;
  const commands = Array.isArray(resolved.data) ? resolved.data : [resolved.data];
  const paths = commands.flatMap((command, index) => {
    if (!["set_flags", "change_message_state", "move", "copy", "delete"].includes(command.kind)) return [];
    const prefix = Array.isArray(resolved.data) ? [String(index)] : [];
    return [{ path: [...prefix, "target", "messageId"], table: "messages" as const }];
  });
  return projectResourcePaths(resolved, paths);
};
const respondCommands = async <T extends MailCommand | MailCommand[]>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) =>
  respondPublic(c, await projectCommands(result));
const internalCommandInput = async (c: Context<MailApiContext>, input: MailCommandInput): Promise<MailCommandInput> => {
  const resolved = await internalInput(c, input);
  switch (resolved.kind) {
    case "set_flags":
    case "change_message_state":
    case "move":
    case "copy":
    case "delete": {
      const messageId = await publicResources.resolveMailboxPublicId("messages", internalMailboxId(c), resolved.messageId);
      if (!messageId) throw new HTTPException(404, { message: "Mail resource not found" });
      return { ...resolved, messageId };
    }
    default:
      return resolved;
  }
};
const respondMessageSource = async <T>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) =>
  respondPublic(c, await projectRootRelation(await result, "messageId", "messages"));
const respondMergedConversations = async <T extends { removedConversationId: string }>(
  c: Context<MailApiContext>,
  result: Result<T> | Promise<Result<T>>,
  removedConversationId: string,
) => {
  const projected = await projectResourcePaths(await result, [{ path: ["target", "id"], table: "conversations" }]);
  return respondPublic(c, projected.ok ? ok({ ...projected.data, removedConversationId }) : projected);
};
const respondSplitConversations = async <T>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) =>
  respondPublic(
    c,
    await projectResourcePaths(await result, [
      { path: ["source", "id"], table: "conversations" },
      { path: ["created", "id"], table: "conversations" },
    ]),
  );
const respondReassignedMessage = async <T>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) =>
  respondPublic(
    c,
    await projectResourcePaths(await result, [
      { path: ["source", "id"], table: "conversations" },
      { path: ["target", "id"], table: "conversations" },
      { path: ["messageId"], table: "messages" },
    ]),
  );

const aggregateResourcePaths = (data: unknown) => {
  const paths: Array<{ path: string[]; table: Parameters<typeof projectResourcePaths>[1][number]["table"] }> = [];
  const at = (path: readonly string[]): unknown => {
    let value = data;
    for (const segment of path)
      value = Array.isArray(value)
        ? value[Number(segment)]
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[segment]
          : undefined;
    return value;
  };
  const one = (path: string[], table: (typeof paths)[number]["table"]) => {
    const value = at(path);
    if (value && typeof value === "object" && "id" in value) paths.push({ path: [...path, "id"], table });
  };
  const many = (path: string[], table: (typeof paths)[number]["table"]) => {
    const values = at(path);
    if (!Array.isArray(values)) return;
    values.forEach((_value, index) => one([...path, String(index)], table));
  };

  one(["mailbox"], "mailboxes");
  for (const [field, table] of [
    ["savedViewId", "savedViews"],
    ["folderId", "folders"],
    ["conversationId", "conversations"],
    ["selectedConversationId", "conversations"],
    ["selectedMessageId", "messages"],
  ] as const) {
    if (typeof at([field]) === "string") paths.push({ path: [field], table });
  }
  many(["folders"], "folders");
  many(["identities"], "senderIdentities");
  many(["savedViews"], "savedViews");
  many(["scheduledPage", "items"], "deliveries");
  many(["detailMessages"], "messages");
  many(["conversationDrafts"], "drafts");
  many(["localTags"], "tags");
  many(["conversationLocalTags", "tags"], "tags");
  many(["comments"], "comments");
  one(["reminder"], "reminders");
  many(["organization", "savedViews"], "savedViews");
  many(["organization", "localTags"], "tags");
  many(["compose", "templates"], "composeTemplates");
  many(["compose", "identities"], "senderIdentities");
  many(["admin", "folders"], "folders");
  many(["admin", "identities"], "senderIdentities");

  const listItems = at(["listItems"]);
  if (Array.isArray(listItems)) {
    listItems.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      paths.push({
        path: ["listItems", String(index), "id"],
        table: "selectionKind" in item && item.selectionKind === "conversation" ? "conversations" : "messages",
      });
      if ("attachmentMatch" in item && item.attachmentMatch) {
        paths.push(
          { path: ["listItems", String(index), "attachmentMatch", "attachmentId"], table: "attachments" },
          { path: ["listItems", String(index), "attachmentMatch", "messageId"], table: "messages" },
        );
      }
      many(["listItems", String(index), "localTags"], "tags");
    });
  }
  const detailMessages = at(["detailMessages"]);
  if (Array.isArray(detailMessages)) {
    detailMessages.forEach((_message, index) => {
      many(["detailMessages", String(index), "attachments"], "attachments");
      const submissionId = at(["detailMessages", String(index), "delivery", "submissionId"]);
      if (typeof submissionId === "string") {
        paths.push({ path: ["detailMessages", String(index), "delivery", "submissionId"], table: "deliveries" });
      }
    });
  }
  return paths;
};

const respondAggregate = async <T>(c: Context<MailApiContext>, result: Result<T> | Promise<Result<T>>) => {
  const resolved = await result;
  return respondPublic(c, resolved.ok ? await projectResourcePaths(resolved, aggregateResourcePaths(resolved.data)) : resolved);
};

const readBoundedBody = async (body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Result<Uint8Array>> => {
  if (!body) return fail(err.badInput("Request body is required"));
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body-too-large");
        return fail(err.badInput(`Request body cannot exceed ${maxBytes} bytes`));
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, data: bytes };
};

const attachmentDownloadResponse = async (
  c: Context<MailApiContext>,
  result: Result<AttachmentDownload>,
  query: z.infer<typeof attachmentQuerySchema>,
  assertCurrentAccess?: (blobId: string) => Promise<void>,
) => {
  if (!result.ok) return respondPublic(c, result);
  const rangeHeader = c.req.header("range");
  const hasQueryRange = query.offset !== undefined || query.length !== undefined;
  if (rangeHeader && hasQueryRange)
    return respondPublic(c, fail(err.badInput("Use either the Range header or offset and length query parameters")));
  const { blobId, total, chunkSize, chunkCount, contentHash, contentType, filename } = result.data;
  const responseType = safeAttachmentContentType(contentType).toLowerCase();
  const previewKind = attachmentPreviewKind(responseType, total);
  if (query.inline === true && !previewKind) {
    return respondPublic(c, fail(err.badInput("This attachment type or size cannot be previewed safely")));
  }
  const inline = query.inline === true;
  if (inline) {
    const prefix = await messages.readAttachmentPrefix(blobId);
    if (!attachmentPreviewSignatureMatches(responseType, prefix)) {
      return respondPublic(c, fail(err.badInput("The attachment content does not match its declared preview type")));
    }
  }
  const requestedRange =
    rangeHeader ?? (hasQueryRange ? `bytes=${query.offset ?? 0}-${(query.offset ?? 0) + (query.length ?? 1024 * 1024) - 1}` : null);
  const range = resolveByteRange(requestedRange, total);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${total}`,
        "Cache-Control": "private, no-store",
      },
    });
  }
  const selectedRange = range ?? { start: 0, endExclusive: total };
  const partial = range !== null;
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Length": String(selectedRange.endExclusive - selectedRange.start),
    "Content-Type": responseType,
    "Content-Disposition": attachmentContentDisposition(filename, inline),
    ETag: `"${contentHash}"`,
    "Cache-Control": "private, no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (inline) headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  if (partial) headers.set("Content-Range", `bytes ${selectedRange.start}-${selectedRange.endExclusive - 1}/${total}`);
  return new Response(
    messages.createAttachmentStream({
      blobId,
      chunkSize,
      chunkCount,
      start: selectedRange.start,
      endExclusive: selectedRange.endExclusive,
      assertCurrentAccess: assertCurrentAccess ? () => assertCurrentAccess(blobId) : undefined,
    }),
    { status: partial ? 206 : 200, headers },
  );
};

const resolveFolderParam = resolveMailboxResourceParam("folders", "folderId", "Folder");
const resolveConversationParam = resolveMailboxResourceParam("conversations", "conversationId", "Conversation");
const resolveMessageParam = resolveMailboxResourceParam("messages", "messageId", "Message");
const resolveReceivedAttachmentParam = resolveMailboxResourceParam("attachments", "attachmentId", "Attachment");
const resolveDraftParam = resolveMailboxResourceParam("drafts", "draftId", "Draft");
const resolveDraftAttachmentParam = resolveMailboxResourceParam("draftAttachments", "attachmentId", "Attachment");
const resolveSenderIdentityParam = resolveMailboxResourceParam("senderIdentities", "senderIdentityId", "Sender identity");
const resolveCommentParam = resolveMailboxResourceParam("comments", "commentId", "Comment");
const resolveSavedViewParam = resolveMailboxResourceParam("savedViews", "viewId", "Saved view");
const resolveComposeTemplateParam = resolveMailboxResourceParam("composeTemplates", "templateId", "Compose template");
const resolveScheduledSendParam = resolveMailboxResourceParam("deliveries", "scheduledSendId", "Scheduled send");

const mailOperationsApi = new Hono<MailApiContext>()
  .use("/mailboxes/:mailboxId", resolveMailboxParam)
  .use("/mailboxes/:mailboxId/*", resolveMailboxParam)
  .use("/mailboxes/:mailboxId/folders/:folderId", resolveFolderParam)
  .use("/mailboxes/:mailboxId/folders/:folderId/*", resolveFolderParam)
  .use("/mailboxes/:mailboxId/conversations/:conversationId", resolveConversationParam)
  .use("/mailboxes/:mailboxId/conversations/:conversationId/*", resolveConversationParam)
  .use("/mailboxes/:mailboxId/workspace-detail/:conversationId", resolveConversationParam)
  .use("/mailboxes/:mailboxId/messages/:messageId", resolveMessageParam)
  .use("/mailboxes/:mailboxId/messages/:messageId/*", resolveMessageParam)
  .use("/mailboxes/:mailboxId/messages/:messageId/attachments/:attachmentId", resolveReceivedAttachmentParam)
  .use("/mailboxes/:mailboxId/messages/:messageId/attachments/:attachmentId/*", resolveReceivedAttachmentParam)
  .use("/mailboxes/:mailboxId/drafts/:draftId", resolveDraftParam)
  .use("/mailboxes/:mailboxId/drafts/:draftId/*", resolveDraftParam)
  .use("/mailboxes/:mailboxId/drafts/:draftId/attachments/:attachmentId", resolveDraftAttachmentParam)
  .use("/mailboxes/:mailboxId/drafts/:draftId/attachments/:attachmentId/*", resolveDraftAttachmentParam)
  .use("/mailboxes/:mailboxId/sender-identities/:senderIdentityId", resolveSenderIdentityParam)
  .use("/mailboxes/:mailboxId/sender-identities/:senderIdentityId/*", resolveSenderIdentityParam)
  .use("/mailboxes/:mailboxId/conversations/:conversationId/comments/:commentId", resolveCommentParam)
  .use("/mailboxes/:mailboxId/conversations/:conversationId/comments/:commentId/*", resolveCommentParam)
  .use("/mailboxes/:mailboxId/notification-targets/reminder/:sourceId", resolveReminderNotificationSourceParam)
  .use("/mailboxes/:mailboxId/saved-views/:viewId", resolveSavedViewParam)
  .use("/mailboxes/:mailboxId/saved-views/:viewId/*", resolveSavedViewParam)
  .use("/mailboxes/:mailboxId/compose-templates/:templateId", resolveComposeTemplateParam)
  .use("/mailboxes/:mailboxId/compose-templates/:templateId/*", resolveComposeTemplateParam)
  .use("/mailboxes/:mailboxId/scheduled-sends/:scheduledSendId", resolveScheduledSendParam)
  .use("/mailboxes/:mailboxId/scheduled-sends/:scheduledSendId/*", resolveScheduledSendParam)
  .use(auth.requireRole("authenticated"))
  .get(
    "/overview/conversations",
    describeRoute({
      tags: ["Mail:Conversations"],
      summary: "List focused conversations across readable mailboxes",
      ...requiresAuth,
      responses: {
        200: jsonResponse(mailFocusPageSchema, "Cross-mailbox focus page"),
        400: jsonResponse(ErrorResponseSchema, "Invalid view or cursor"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
      },
    }),
    v("query", mailFocusQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      return respondFocus(
        c,
        focus.listFocusConversations({
          context: requestContext(c),
          view: query.view,
          cursor: query.cursor,
          limit: query.limit,
        }),
      );
    },
  )
  .get("/mailboxes/:mailboxId/provider-discovery", v("param", mailboxParamSchema), v("query", providerDiscoveryQuerySchema), async (c) => {
    const mailboxId = internalMailboxId(c);
    const allowed = await mailboxAccess.requireMailboxPermission(requestContext(c), mailboxId, "admin");
    if (!allowed.ok) return respondPublic(c, allowed);
    return respondPublic(c, ok(await discoverMailConfigurations((await internalInput(c, c.req.valid("query"))).email)));
  })
  .get("/mailboxes", v("query", mailboxListQuerySchema), async (c) => {
    const query = c.req.valid("query");
    return respondMailboxes(c, mailboxes.listMailboxes(requestContext(c), query.limit, query.name, query.q));
  })
  .post("/mailboxes", v("json", createMailboxInputSchema), async (c) =>
    respondMailboxes(c, mailboxes.createMailbox(requestContext(c), c.req.valid("json"))),
  )
  .get("/mailboxes/:mailboxId", v("param", mailboxParamSchema), async (c) =>
    respondMailboxes(c, mailboxes.getMailbox(requestContext(c), internalMailboxId(c))),
  )
  .get("/mailboxes/:mailboxId/workspace-route", v("param", mailboxParamSchema), v("query", workspaceRouteQuerySchema), async (c) => {
    const mailboxId = internalMailboxId(c);
    const query = await internalInput(c, c.req.valid("query"));
    const requestUrl = await parseWorkspaceRouteUrl(c.req.valid("param").mailboxId, mailboxId, query.href);
    if (!requestUrl) return respondPublic(c, fail(err.badInput("Workspace route must target this mailbox")));
    const data = await loadMailboxPageData({
      context: requestContext(c),
      mailboxId,
      requestUrl,
      listMode: query.listMode,
    });
    return respondAggregate(c, data ? { ok: true, data } : fail(err.notFound("Mailbox")));
  })
  .get(
    "/mailboxes/:mailboxId/workspace-detail/:conversationId",
    v(
      "param",
      z.object({
        mailboxId: ResourceShortIdSchema,
        conversationId: ResourceShortIdSchema,
      }),
    ),
    async (c) => {
      const params = internalParams(c, c.req.valid("param"));
      const detail = await loadMailboxConversationDetail({
        context: requestContext(c),
        ...params,
      });
      return respondAggregate(c, detail ? { ok: true, data: detail } : fail(err.notFound("Conversation")));
    },
  )
  .get(
    "/mailboxes/:mailboxId/conversations/:conversationId/context",
    describeRoute({
      tags: ["Mail:Context"],
      summary: "Get permission-scoped Contacts context",
      description: "Resolves current conversation participants through Contacts without storing foreign contact metadata.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(mailConversationContextSchema, "Conversation context"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Conversation not found"),
      },
    }),
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("query", mailConversationContextQuerySchema),
    async (c) =>
      respondPublic(
        c,
        conversationContext.getConversationContext({
          context: requestContext(c),
          request: integrationRequest(c),
          ...internalParams(c, c.req.valid("param") as { mailboxId: string; conversationId: string }),
          query: await internalInput(c, c.req.valid("query")),
        }),
      ),
  )
  .get(
    "/mailboxes/:mailboxId/conversations/:conversationId/spaces/items",
    describeRoute({
      tags: ["Mail:Context"],
      summary: "Search writable Space items",
      ...requiresAuth,
      responses: {
        200: jsonResponse(spacesItemSearchDataSchema, "Space items"),
        503: jsonResponse(ErrorResponseSchema, "Spaces unavailable"),
      },
    }),
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("query", mailConversationSpaceSearchQuerySchema),
    async (c) => {
      const result = await conversationContext.searchConversationSpaceItems({
        context: requestContext(c),
        request: integrationRequest(c),
        ...internalParams(c, c.req.valid("param") as { mailboxId: string; conversationId: string }),
        query: c.req.valid("query").query,
      });
      return respondAppDependency(c, result);
    },
  )
  .post(
    "/mailboxes/:mailboxId/conversations/:conversationId/spaces/link",
    describeRoute({
      tags: ["Mail:Context"],
      summary: "Link the conversation to a Space item",
      ...requiresAuth,
      responses: {
        200: jsonResponse(spacesItemResourceReferenceSchema, "Linked resource"),
        503: jsonResponse(ErrorResponseSchema, "Spaces unavailable"),
      },
    }),
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("json", mailConversationSpaceLinkInputSchema),
    async (c) => {
      const result = await conversationContext.linkConversationSpaceItem({
        context: requestContext(c),
        request: integrationRequest(c),
        ...internalParams(c, c.req.valid("param") as { mailboxId: string; conversationId: string }),
        itemId: c.req.valid("json").itemId,
      });
      return respondAppDependency(c, result);
    },
  )
  .post(
    "/mailboxes/:mailboxId/conversations/:conversationId/spaces/unlink",
    describeRoute({
      tags: ["Mail:Context"],
      summary: "Unlink the conversation from a Space item",
      ...requiresAuth,
      responses: {
        200: jsonResponse(spacesItemReferenceRemoveDataSchema, "Unlinked resource"),
        503: jsonResponse(ErrorResponseSchema, "Spaces unavailable"),
      },
    }),
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("json", mailConversationSpaceLinkInputSchema),
    async (c) => {
      const result = await conversationContext.unlinkConversationSpaceItem({
        context: requestContext(c),
        request: integrationRequest(c),
        ...internalParams(c, c.req.valid("param") as { mailboxId: string; conversationId: string }),
        itemId: c.req.valid("json").itemId,
      });
      return respondAppDependency(c, result);
    },
  )
  .post(
    "/mailboxes/:mailboxId/conversations/:conversationId/spaces/items",
    describeRoute({
      tags: ["Mail:Context"],
      summary: "Create a linked Space task or event",
      ...requiresAuth,
      responses: {
        200: jsonResponse(spacesItemMutationDataSchema, "Created Space item"),
        503: jsonResponse(ErrorResponseSchema, "Spaces unavailable"),
      },
    }),
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("json", mailConversationSpaceCreateInputSchema),
    async (c) => {
      const result = await conversationContext.createConversationSpaceItem({
        context: requestContext(c),
        request: integrationRequest(c),
        ...internalParams(c, c.req.valid("param") as { mailboxId: string; conversationId: string }),
        input: c.req.valid("json"),
      });
      return respondAppDependency(c, result);
    },
  )
  .get(
    "/mailboxes/:mailboxId/conversations/:conversationId/related",
    describeRoute({
      tags: ["Mail:Context"],
      summary: "List related Mail conversations",
      description:
        "Returns a small explainable ranking from the current mailbox using shared external participants and normalized subjects.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(relatedConversationListSchema, "Related conversations"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Conversation not found"),
      },
    }),
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("query", relatedConversationQuerySchema),
    async (c) =>
      respondConversations(
        c,
        conversationContext.listRelatedConversations({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param") as { mailboxId: string; conversationId: string }),
          limit: c.req.valid("query").limit,
        }),
      ),
  )
  .get(
    "/mailboxes/:mailboxId/conversations/:conversationId/contacts/:bookId/:contactId/history",
    describeRoute({
      tags: ["Mail:Context"],
      summary: "List related Mail for a currently readable participant contact",
      description: "Rechecks the Contact match and returns keyset-paginated conversations from the current mailbox only.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(relatedMailPageSchema, "Related conversations"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Contact or conversation not found"),
        503: jsonResponse(ErrorResponseSchema, "Contacts unavailable"),
      },
    }),
    v(
      "param",
      z.object({
        mailboxId: ResourceShortIdSchema,
        conversationId: ResourceShortIdSchema,
        bookId: z.union([ResourceShortIdSchema, z.literal("system")]),
        contactId: ResourceShortIdSchema,
      }),
    ),
    v("query", relatedMailQuerySchema),
    async (c) => {
      const result = await conversationContext.listRelatedMail({
        context: requestContext(c),
        request: integrationRequest(c),
        ...internalParams(c, c.req.valid("param")),
        ...(await internalInput(c, c.req.valid("query"))),
      });
      return respondAppDependency(c, result);
    },
  )
  .get("/mailboxes/:mailboxId/settings-context", v("param", mailboxParamSchema), async (c) =>
    respondAggregate(c, settingsContext.loadMailboxSettingsContext(requestContext(c), internalMailboxId(c))),
  )
  .get(
    "/mailboxes/:mailboxId/calendar-destinations",
    describeRoute({
      tags: ["Mail:Calendar"],
      summary: "List writable Spaces calendar destinations",
      ...requiresAuth,
      responses: { 200: jsonResponse(calendarDestinationsResponseSchema, "Mailbox calendar destinations") },
    }),
    v("param", mailboxParamSchema),
    async (c) => {
      const mailboxId = internalMailboxId(c);
      const destinations = await calendarInvitations.listDestinations({
        context: requestContext(c),
        mailboxId,
        request: integrationRequest(c),
      });
      if (!destinations.ok) return respondPublic(c, destinations);
      return respondPublic(c, destinations);
    },
  )
  .get(
    "/mailboxes/:mailboxId/spaces/:spaceId",
    describeRoute({
      tags: ["Mail:Context"],
      summary: "Read a writable Space for Mail item creation",
      ...requiresAuth,
      responses: {
        200: jsonResponse(spaceDetailSchema, "Space detail"),
        503: jsonResponse(ErrorResponseSchema, "Spaces unavailable"),
      },
    }),
    v("param", z.object({ mailboxId: ResourceShortIdSchema, spaceId: ResourceShortIdSchema })),
    v("query", z.object({ conversationId: ResourceShortIdSchema }).strict()),
    async (c) => {
      const mailboxId = internalMailboxId(c);
      const conversationId = c.req.valid("query").conversationId;
      const internalConversationId = await publicResources.resolveMailboxPublicId("conversations", mailboxId, conversationId);
      if (!internalConversationId) return respondPublic(c, fail(err.notFound("Conversation")));
      const result = await conversationContext.getConversationSpace({
        context: requestContext(c),
        request: integrationRequest(c),
        mailboxId,
        conversationId: internalConversationId,
        spaceId: c.req.valid("param").spaceId,
      });
      return respondAppDependency(c, result);
    },
  )
  .put(
    "/mailboxes/:mailboxId/calendar-destination",
    describeRoute({
      tags: ["Mail:Calendar"],
      summary: "Set the mailbox's default Space",
      description: "Validates current write access before saving the optional default calendar destination.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(calendarDestinationsResponseSchema, "Updated calendar destination"),
        400: jsonResponse(ErrorResponseSchema, "Destination is unavailable"),
        403: jsonResponse(ErrorResponseSchema, "Mailbox admin required"),
      },
    }),
    v("param", mailboxParamSchema),
    v("json", calendarDestinationInputSchema),
    async (c) => {
      const mailboxId = internalMailboxId(c);
      const input = await internalInput(c, c.req.valid("json"));
      const updated = await calendarInvitations.setDefaultDestination({
        context: requestContext(c),
        mailboxId,
        spaceId: input.spaceId,
        request: integrationRequest(c),
      });
      return respondPublic(c, updated);
    },
  )
  .get(
    "/mailboxes/:mailboxId/calendar-events",
    describeRoute({
      tags: ["Mail:Calendar"],
      summary: "List writable Space events for the composer",
      ...requiresAuth,
      responses: {
        200: jsonResponse(calendarEventsSchema, "Calendar events"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
      },
    }),
    v("param", mailboxParamSchema),
    v("query", calendarEventsQuerySchema),
    async (c) => {
      const { mailboxId } = internalParams(c, c.req.valid("param"));
      const query = await internalInput(c, c.req.valid("query"));
      return respondPublic(
        c,
        calendarInvitations.listComposerEvents({
          context: requestContext(c),
          mailboxId,
          spaceId: query.spaceId,
          query: query.query,
          request: integrationRequest(c),
        }),
      );
    },
  )
  .post(
    "/mailboxes/:mailboxId/calendar-events",
    describeRoute({
      tags: ["Mail:Calendar"],
      summary: "Create a Space event for the current composer",
      ...requiresAuth,
      responses: {
        200: jsonResponse(calendarEventSchema, "Created calendar event"),
        400: jsonResponse(ErrorResponseSchema, "Invalid event"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
      },
    }),
    v("param", mailboxParamSchema),
    v("json", createCalendarEventInputSchema),
    async (c) => {
      const { mailboxId } = internalParams(c, c.req.valid("param"));
      return respondPublic(
        c,
        calendarInvitations.createComposerEvent({
          context: requestContext(c),
          mailboxId,
          ...c.req.valid("json"),
          request: integrationRequest(c),
        }),
      );
    },
  )
  .post(
    "/mailboxes/:mailboxId/drafts/:draftId/calendar-invitation",
    describeRoute({
      tags: ["Mail:Calendar"],
      summary: "Attach an idempotent Space event invitation to a draft",
      description: "Derives organizer and visible attendees from the authorized Mail draft; Bcc recipients are never disclosed.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(draftSchema, "Draft with calendar invitation"),
        400: jsonResponse(ErrorResponseSchema, "Invitation cannot be attached"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        409: jsonResponse(ErrorResponseSchema, "Draft changed"),
      },
    }),
    v("param", mailboxAndIdParamSchema("draftId")),
    v("json", attachCalendarEventInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as { mailboxId: string; draftId: string };
      return respondDrafts(
        c,
        calendarInvitations.attachEventInvitation({
          context: requestContext(c),
          ...params,
          ...(await internalInput(c, c.req.valid("json"))),
          request: integrationRequest(c),
        }),
      );
    },
  )
  .get(
    "/mailboxes/:mailboxId/messages/:messageId/calendar-invitation",
    describeRoute({
      tags: ["Mail:Calendar"],
      summary: "Preview a message calendar invitation",
      ...requiresAuth,
      responses: {
        200: jsonResponse(calendarInvitationPreviewSchema, "Calendar invitation"),
        404: jsonResponse(ErrorResponseSchema, "No calendar invitation"),
      },
    }),
    v("param", mailboxAndIdParamSchema("messageId")),
    async (c) =>
      respondPublic(
        c,
        calendarInvitations.preview({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param") as { mailboxId: string; messageId: string }),
          request: integrationRequest(c),
        }),
      ),
  )
  .post(
    "/mailboxes/:mailboxId/messages/:messageId/calendar-invitation/import",
    describeRoute({
      tags: ["Mail:Calendar"],
      summary: "Add or update an invitation in Spaces",
      ...requiresAuth,
      responses: { 200: jsonResponse(calendarInvitationImportResultSchema, "Imported event") },
    }),
    v("param", mailboxAndIdParamSchema("messageId")),
    v("json", calendarImportInputSchema),
    async (c) =>
      respondPublic(
        c,
        calendarInvitations.importToSpace({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param") as { mailboxId: string; messageId: string }),
          ...(await internalInput(c, c.req.valid("json"))),
          request: integrationRequest(c),
        }),
      ),
  )
  .post(
    "/mailboxes/:mailboxId/messages/:messageId/calendar-invitation/respond",
    describeRoute({
      tags: ["Mail:Calendar"],
      summary: "Create a calendar response draft",
      description: "Creates a normal editable Mail draft with a standards-based iTIP REPLY attachment.",
      ...requiresAuth,
      responses: { 200: jsonResponse(draftSchema, "Calendar response draft") },
    }),
    v("param", mailboxAndIdParamSchema("messageId")),
    v("json", calendarResponseInputSchema),
    async (c) =>
      respondDrafts(
        c,
        calendarInvitations.createResponseDraft({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param") as { mailboxId: string; messageId: string }),
          participationStatus: (await internalInput(c, c.req.valid("json"))).participationStatus,
          idempotencyKey: (await internalInput(c, c.req.valid("json"))).idempotencyKey,
          spaceId: (await internalInput(c, c.req.valid("json"))).spaceId,
          request: integrationRequest(c),
        }),
      ),
  )
  .get("/mailboxes/:mailboxId/health", v("param", mailboxParamSchema), async (c) =>
    respondPublic(c, health.getMailboxOperationalHealth(requestContext(c), internalMailboxId(c))),
  )
  .get("/mailboxes/:mailboxId/subscriptions", v("param", mailboxParamSchema), v("query", subscriptionQuerySchema), async (c) => {
    const params = internalParams(c, c.req.valid("param"));
    const query = await internalInput(c, c.req.valid("query"));
    return respondPublic(
      c,
      listSubscriptions.listSubscriptions({
        context: requestContext(c),
        mailboxId: params.mailboxId,
        cursor: query.cursor,
        limit: query.limit,
        focusedListKey: query.listKey,
      }),
    );
  })
  .post(
    "/mailboxes/:mailboxId/subscriptions/unsubscribe",
    v("param", mailboxParamSchema),
    v("json", unsubscribeMailingListInputSchema),
    async (c) =>
      respondPublic(
        c,
        listSubscriptions.requestUnsubscribe({
          context: requestContext(c),
          mailboxId: internalMailboxId(c),
          input: await internalInput(c, c.req.valid("json")),
        }),
      ),
  )
  .post(
    "/mailboxes/:mailboxId/subscriptions/disposition",
    v("param", mailboxParamSchema),
    v("json", mailingListDispositionInputSchema),
    async (c) =>
      respondPublic(
        c,
        listSubscriptions.applyMailingListDisposition({
          context: requestContext(c),
          mailboxId: internalMailboxId(c),
          input: await internalInput(c, c.req.valid("json")),
        }),
      ),
  )
  .get("/mailboxes/:mailboxId/operations", v("param", mailboxParamSchema), v("query", mailboxOperationsQuerySchema), async (c) =>
    respondPublic(
      c,
      operations.getMailboxOperations(requestContext(c), internalMailboxId(c), await internalInput(c, c.req.valid("query"))),
    ),
  )
  .patch("/mailboxes/:mailboxId", v("param", mailboxParamSchema), v("json", updateMailboxSchema), async (c) =>
    respondMailboxes(
      c,
      mailboxes.updateMailbox({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        ...(await internalInput(c, c.req.valid("json"))),
      }),
    ),
  )
  .delete("/mailboxes/:mailboxId", v("param", mailboxParamSchema), async (c) =>
    respondMailboxes(c, mailboxes.deleteMailbox(requestContext(c), internalMailboxId(c))),
  )
  .get("/mailboxes/:mailboxId/access", v("param", mailboxParamSchema), async (c) =>
    respondPublic(c, mailboxAccess.listMailboxAccess(requestContext(c), internalMailboxId(c))),
  )
  .post("/mailboxes/:mailboxId/access", v("param", mailboxParamSchema), v("json", GrantAccessSchema), async (c) => {
    const input = await internalInput(c, c.req.valid("json"));
    if (input.permission === "none") return respondPublic(c, fail(err.badInput("Access permission cannot be none")));
    return respondPublic(
      c,
      mailboxAccess.grantMailboxAccess({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        principal: input.principal,
        permission: input.permission,
      }),
    );
  })
  .patch(
    "/mailboxes/:mailboxId/access/:accessId",
    v("param", mailboxAndIdParamSchema("accessId", z.uuid())),
    v("json", UpdateAccessSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        accessId: string;
      };
      const { permission } = await internalInput(c, c.req.valid("json"));
      if (permission === "none") return respondPublic(c, fail(err.badInput("Use DELETE to revoke access")));
      return respondPublic(
        c,
        mailboxAccess.updateMailboxAccess({
          context: requestContext(c),
          ...params,
          permission,
        }),
      );
    },
  )
  .delete("/mailboxes/:mailboxId/access/:accessId", v("param", mailboxAndIdParamSchema("accessId", z.uuid())), async (c) => {
    const params = internalParams(c, c.req.valid("param")) as {
      mailboxId: string;
      accessId: string;
    };
    return respondPublic(
      c,
      mailboxAccess.revokeMailboxAccess({
        context: requestContext(c),
        ...params,
      }),
    );
  })
  .get("/mailboxes/:mailboxId/connections", v("param", mailboxParamSchema), async (c) =>
    respondPublic(c, providerConnections.listProviderConnections(requestContext(c), internalMailboxId(c))),
  )
  .post("/mailboxes/:mailboxId/connections", v("param", mailboxParamSchema), v("json", providerConnectionInputSchema), async (c) =>
    respondPublic(
      c,
      providerConnections.createProviderConnection({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        input: await internalInput(c, c.req.valid("json")),
      }),
    ),
  )
  .put(
    "/mailboxes/:mailboxId/connections/:connectionId",
    v("param", mailboxAndIdParamSchema("connectionId", z.uuid())),
    v("json", providerConnectionInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        connectionId: string;
      };
      const current = await providerConnections.getProviderConnection(requestContext(c), params.connectionId);
      if (!current.ok) return respondPublic(c, current);
      if (current.data.mailboxId !== params.mailboxId) return respondPublic(c, fail(err.notFound("Provider connection")));
      return respondPublic(
        c,
        providerConnections.replaceProviderConnection({
          context: requestContext(c),
          connectionId: params.connectionId,
          input: await internalInput(c, c.req.valid("json")),
        }),
      );
    },
  )
  .delete("/mailboxes/:mailboxId/connections/:connectionId", v("param", mailboxAndIdParamSchema("connectionId", z.uuid())), async (c) => {
    const params = internalParams(c, c.req.valid("param")) as {
      mailboxId: string;
      connectionId: string;
    };
    const current = await providerConnections.getProviderConnection(requestContext(c), params.connectionId);
    if (!current.ok) return respondPublic(c, current);
    if (current.data.mailboxId !== params.mailboxId) return respondPublic(c, fail(err.notFound("Provider connection")));
    return respondPublic(c, providerConnections.revokeProviderConnection(requestContext(c), params.connectionId));
  })
  .post(
    "/mailboxes/:mailboxId/connections/:connectionId/limits/refresh",
    v("param", mailboxAndIdParamSchema("connectionId", z.uuid())),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        connectionId: string;
      };
      return respondPublic(
        c,
        providerConnections.refreshProviderConnectionLimits({
          context: requestContext(c),
          ...params,
        }),
      );
    },
  )
  .get("/mailboxes/:mailboxId/bindings", v("param", mailboxParamSchema), async (c) =>
    respondPublic(c, bindings.listProviderBindings(requestContext(c), internalMailboxId(c))),
  )
  .post("/mailboxes/:mailboxId/bindings", v("param", mailboxParamSchema), v("json", attachBindingSchema), async (c) =>
    respondPublic(
      c,
      bindings.attachProviderBinding({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        ...(await internalInput(c, c.req.valid("json"))),
      }),
    ),
  )
  .post("/mailboxes/:mailboxId/sync", v("param", mailboxParamSchema), async (c) => {
    const mailboxId = internalMailboxId(c);
    return respondCommands(
      c,
      commands.createMaintenanceCommand({
        context: requestContext(c),
        mailboxId,
        input: {
          kind: "sync_mailbox",
          idempotencyKey: c.req.header("idempotency-key")?.trim() || `manual-sync:${crypto.randomUUID()}`,
        },
      }),
    );
  })
  .get("/mailboxes/:mailboxId/folders", v("param", mailboxParamSchema), async (c) =>
    respondFolders(c, messages.listFolders(requestContext(c), internalMailboxId(c))),
  )
  .patch(
    "/mailboxes/:mailboxId/folders/:folderId",
    v("param", mailboxAndIdParamSchema("folderId")),
    v("json", folderVisibilityInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as { mailboxId: string; folderId: string };
      return respondFolders(
        c,
        folders.setFolderSidebarVisibility({
          context: requestContext(c),
          ...params,
          showInSidebar: (await internalInput(c, c.req.valid("json"))).showInSidebar,
        }),
      );
    },
  )
  .delete("/mailboxes/:mailboxId/folders/:folderId", v("param", mailboxAndIdParamSchema("folderId")), async (c) => {
    const params = internalParams(c, c.req.valid("param")) as { mailboxId: string; folderId: string };
    return respondFolders(
      c,
      folders.dismissUnavailableFolder({
        context: requestContext(c),
        ...params,
      }),
    );
  })
  .get("/mailboxes/:mailboxId/notification-targets/:kind/:sourceId", v("param", notificationTargetParamSchema), async (c) => {
    const resolved = await notificationTargets.resolveMailNotificationTarget({
      context: requestContext(c),
      ...internalParams(c, c.req.valid("param")),
    });
    return resolved.ok ? c.redirect(resolved.data.href, 302) : respondPublic(c, resolved);
  })
  .get("/mailboxes/:mailboxId/assignable-users", v("param", mailboxParamSchema), v("query", collaboratorQuerySchema), async (c) =>
    respondPublic(
      c,
      collaboration.listAssignableUsers({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        ...(await internalInput(c, c.req.valid("query"))),
      }),
    ),
  )
  .get("/mailboxes/:mailboxId/conversation-view-counts", v("param", mailboxParamSchema), async (c) =>
    respondPublic(
      c,
      messages.getConversationViewCounts({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
      }),
    ),
  )
  .get("/mailboxes/:mailboxId/activity", v("param", mailboxParamSchema), v("query", activityQuerySchema), async (c) => {
    const result = await collaboration.listActivity({
      context: requestContext(c),
      mailboxId: internalMailboxId(c),
      ...(await internalInput(c, c.req.valid("query"))),
    });
    return respondPublic(c, projectActivityResult(result));
  })
  .put("/mailboxes/:mailboxId/folder-roles/:role", v("param", roleParamSchema), v("json", folderRoleInputSchema), async (c) =>
    respondFolders(
      c,
      folders.setFolderRole({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        role: c.req.valid("param").role,
        folderId: (await internalInput(c, c.req.valid("json"))).folderId,
      }),
    ),
  )
  .delete("/mailboxes/:mailboxId/folder-roles/:role", v("param", roleParamSchema), async (c) =>
    respondFolders(
      c,
      folders.clearFolderRole({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        role: c.req.valid("param").role,
      }),
    ),
  )
  .get("/mailboxes/:mailboxId/conversations", v("param", mailboxParamSchema), v("query", conversationQuerySchema), async (c) =>
    respondConversations(
      c,
      messages.listConversations({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        ...(await internalInput(c, c.req.valid("query"))),
      }),
    ),
  )
  .get("/mailboxes/:mailboxId/saved-views", v("param", mailboxParamSchema), async (c) =>
    respondSavedViews(
      c,
      savedViews.listSavedConversationViews({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
      }),
    ),
  )
  .post("/mailboxes/:mailboxId/saved-views", v("param", mailboxParamSchema), v("json", createSavedConversationViewSchema), async (c) =>
    respondSavedViews(
      c,
      savedViews.createSavedConversationView({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        input: await internalInput(c, c.req.valid("json")),
      }),
    ),
  )
  .get("/mailboxes/:mailboxId/saved-views/:viewId", v("param", mailboxAndIdParamSchema("viewId")), async (c) =>
    respondSavedViews(
      c,
      savedViews.getSavedConversationView({
        context: requestContext(c),
        ...internalParams(c, c.req.valid("param") as { mailboxId: string; viewId: string }),
      }),
    ),
  )
  .patch(
    "/mailboxes/:mailboxId/saved-views/:viewId",
    v("param", mailboxAndIdParamSchema("viewId")),
    v("json", updateSavedConversationViewSchema),
    async (c) =>
      respondSavedViews(
        c,
        savedViews.updateSavedConversationView({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param") as { mailboxId: string; viewId: string }),
          input: await internalInput(c, c.req.valid("json")),
        }),
      ),
  )
  .put(
    "/mailboxes/:mailboxId/sender-identities/:senderIdentityId/transport",
    v("param", mailboxAndIdParamSchema("senderIdentityId")),
    v("json", updateSenderIdentityTransportInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        senderIdentityId: string;
      };
      return respondPublic(
        c,
        senderIdentityTransports.upsertSenderIdentityTransport({
          context: requestContext(c),
          ...params,
          input: await internalInput(c, c.req.valid("json")),
        }),
      );
    },
  )
  .delete(
    "/mailboxes/:mailboxId/sender-identities/:senderIdentityId/transport",
    v("param", mailboxAndIdParamSchema("senderIdentityId")),
    v("json", deleteSenderIdentityTransportInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        senderIdentityId: string;
      };
      return respondPublic(
        c,
        senderIdentityTransports.deleteSenderIdentityTransport({
          context: requestContext(c),
          ...params,
          expectedRevision: (await internalInput(c, c.req.valid("json"))).expectedRevision,
        }),
      );
    },
  )
  .delete(
    "/mailboxes/:mailboxId/saved-views/:viewId",
    v("param", mailboxAndIdParamSchema("viewId")),
    v("json", deleteSavedConversationViewSchema),
    async (c) => {
      const publicViewId = c.req.valid("param").viewId;
      const deleted = await savedViews.deleteSavedConversationView({
        context: requestContext(c),
        ...internalParams(c, c.req.valid("param") as { mailboxId: string; viewId: string }),
        expectedRevision: (await internalInput(c, c.req.valid("json"))).expectedRevision,
      });
      return respondPublic(c, deleted.ok ? ok({ id: publicViewId }) : deleted);
    },
  )
  .get(
    "/mailboxes/:mailboxId/saved-views/:viewId/conversations",
    v("param", mailboxAndIdParamSchema("viewId")),
    v("query", cursorQuerySchema),
    async (c) =>
      respondConversations(
        c,
        savedViews.listSavedViewConversations({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param") as { mailboxId: string; viewId: string }),
          ...(await internalInput(c, c.req.valid("query"))),
        }),
      ),
  )
  .get(
    "/mailboxes/:mailboxId/conversations/:conversationId/messages",
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("query", conversationMessagesQuerySchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        conversationId: string;
      };
      return respondMessages(
        c,
        messages.listConversationMessages({
          context: requestContext(c),
          ...params,
          ...(await internalInput(c, c.req.valid("query"))),
        }),
      );
    },
  )
  .get(
    "/mailboxes/:mailboxId/conversations/:conversationId/drafts",
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("query", conversationDraftsQuerySchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        conversationId: string;
      };
      return respondDrafts(
        c,
        drafts.listConversationDrafts({
          context: requestContext(c),
          ...params,
          limit: (await internalInput(c, c.req.valid("query"))).limit,
        }),
      );
    },
  )
  .get("/mailboxes/:mailboxId/conversations/:conversationId/summary", v("param", mailboxAndIdParamSchema("conversationId")), async (c) =>
    respondPublic(
      c,
      conversationSummaries.getConversationSummary({
        context: requestContext(c),
        ...internalParams(c, c.req.valid("param") as { mailboxId: string; conversationId: string }),
      }),
    ),
  )
  .put(
    "/mailboxes/:mailboxId/conversations/:conversationId/summary",
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("json", updateConversationSummarySchema),
    async (c) =>
      respondPublic(
        c,
        conversationSummaries.updateConversationSummary({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param") as { mailboxId: string; conversationId: string }),
          input: await internalInput(c, c.req.valid("json")),
        }),
      ),
  )
  .post(
    "/mailboxes/:mailboxId/conversations/:conversationId/merge",
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("json", mergeConversationsInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        conversationId: string;
      };
      const input = c.req.valid("json");
      return respondMergedConversations(
        c,
        conversations.mergeConversations({
          context: requestContext(c),
          mailboxId: params.mailboxId,
          targetConversationId: params.conversationId,
          input: await internalInput(c, input),
        }),
        input.sourceConversationId,
      );
    },
  )
  .post(
    "/mailboxes/:mailboxId/conversations/:conversationId/split",
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("json", splitConversationInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        conversationId: string;
      };
      return respondSplitConversations(
        c,
        conversations.splitConversation({
          context: requestContext(c),
          mailboxId: params.mailboxId,
          conversationId: params.conversationId,
          input: await internalInput(c, c.req.valid("json")),
        }),
      );
    },
  )
  .post(
    "/mailboxes/:mailboxId/conversations/:conversationId/messages/:messageId/reassign",
    v("param", mailboxAndTwoIdsParamSchema("conversationId", "messageId")),
    v("json", reassignConversationMessageInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        conversationId: string;
        messageId: string;
      };
      return respondReassignedMessage(
        c,
        conversations.reassignConversationMessage({
          context: requestContext(c),
          mailboxId: params.mailboxId,
          sourceConversationId: params.conversationId,
          messageId: params.messageId,
          input: await internalInput(c, c.req.valid("json")),
        }),
      );
    },
  )
  .get(
    "/mailboxes/:mailboxId/conversations/:conversationId/collaboration",
    v("param", mailboxAndIdParamSchema("conversationId")),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        conversationId: string;
      };
      return respondPublic(
        c,
        collaboration.getConversationCollaboration({
          context: requestContext(c),
          ...params,
        }),
      );
    },
  )
  .patch(
    "/mailboxes/:mailboxId/conversations/:conversationId/collaboration",
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("json", updateConversationCollaborationSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        conversationId: string;
      };
      return respondPublic(
        c,
        collaboration.updateConversationCollaboration({
          context: requestContext(c),
          ...params,
          input: await internalInput(c, c.req.valid("json")),
        }),
      );
    },
  )
  .get("/mailboxes/:mailboxId/conversations/:conversationId/reminder", v("param", mailboxAndIdParamSchema("conversationId")), async (c) =>
    respondReminders(
      c,
      reminders.getConversationReminder({
        context: requestContext(c),
        ...internalParams(
          c,
          c.req.valid("param") as {
            mailboxId: string;
            conversationId: string;
          },
        ),
      }),
    ),
  )
  .put(
    "/mailboxes/:mailboxId/conversations/:conversationId/reminder",
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("json", setConversationReminderSchema),
    async (c) =>
      respondReminders(
        c,
        reminders.setConversationReminder({
          context: requestContext(c),
          ...internalParams(
            c,
            c.req.valid("param") as {
              mailboxId: string;
              conversationId: string;
            },
          ),
          input: await internalInput(c, c.req.valid("json")),
        }),
      ),
  )
  .delete(
    "/mailboxes/:mailboxId/conversations/:conversationId/reminder",
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("json", cancelConversationReminderSchema),
    async (c) =>
      respondReminders(
        c,
        reminders.cancelConversationReminder({
          context: requestContext(c),
          ...internalParams(
            c,
            c.req.valid("param") as {
              mailboxId: string;
              conversationId: string;
            },
          ),
          input: await internalInput(c, c.req.valid("json")),
        }),
      ),
  )
  .get("/mailboxes/:mailboxId/conversations/:conversationId/presence", v("param", mailboxAndIdParamSchema("conversationId")), async (c) =>
    respondPublic(
      c,
      presence.getConversationPresence({
        context: requestContext(c),
        ...internalParams(
          c,
          c.req.valid("param") as {
            mailboxId: string;
            conversationId: string;
          },
        ),
      }),
    ),
  )
  .put(
    "/mailboxes/:mailboxId/conversations/:conversationId/presence",
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("json", conversationPresenceHeartbeatSchema),
    async (c) =>
      respondPublic(
        c,
        presence.heartbeatConversationPresence({
          context: requestContext(c),
          ...internalParams(
            c,
            c.req.valid("param") as {
              mailboxId: string;
              conversationId: string;
            },
          ),
          input: await internalInput(c, c.req.valid("json")),
        }),
      ),
  )
  .delete(
    "/mailboxes/:mailboxId/conversations/:conversationId/presence",
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("json", conversationPresenceLeaveSchema),
    async (c) =>
      respondPublic(
        c,
        presence.leaveConversationPresence({
          context: requestContext(c),
          ...internalParams(
            c,
            c.req.valid("param") as {
              mailboxId: string;
              conversationId: string;
            },
          ),
          peerId: (await internalInput(c, c.req.valid("json"))).peerId,
        }),
      ),
  )
  .get(
    "/mailboxes/:mailboxId/conversations/:conversationId/comments",
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("query", conversationCommentsQuerySchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        conversationId: string;
      };
      return respondPublic(
        c,
        collaboration.listConversationComments({
          context: requestContext(c),
          ...params,
          ...(await internalInput(c, c.req.valid("query"))),
        }),
      );
    },
  )
  .post(
    "/mailboxes/:mailboxId/conversations/:conversationId/comments",
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("json", createConversationCommentSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        conversationId: string;
      };
      return respondComments(
        c,
        collaboration.createConversationComment({
          context: requestContext(c),
          ...params,
          input: await internalInput(c, c.req.valid("json")),
        }),
      );
    },
  )
  .patch(
    "/mailboxes/:mailboxId/conversations/:conversationId/comments/:commentId",
    v(
      "param",
      z.object({
        mailboxId: ResourceShortIdSchema,
        conversationId: ResourceShortIdSchema,
        commentId: ResourceShortIdSchema,
      }),
    ),
    v("json", updateConversationCommentSchema),
    async (c) =>
      respondComments(
        c,
        collaboration.updateConversationComment({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param")),
          input: await internalInput(c, c.req.valid("json")),
        }),
      ),
  )
  .delete(
    "/mailboxes/:mailboxId/conversations/:conversationId/comments/:commentId",
    v(
      "param",
      z.object({
        mailboxId: ResourceShortIdSchema,
        conversationId: ResourceShortIdSchema,
        commentId: ResourceShortIdSchema,
      }),
    ),
    v("json", deleteConversationCommentSchema),
    async (c) =>
      respondComments(
        c,
        collaboration.deleteConversationComment({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param")),
          input: await internalInput(c, c.req.valid("json")),
        }),
      ),
  )
  .post(
    "/mailboxes/:mailboxId/conversations/:conversationId/actions",
    v("param", mailboxAndIdParamSchema("conversationId")),
    v("json", conversationTriageInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        conversationId: string;
      };
      return respondPublic(
        c,
        triage.createConversationTriageCommands({
          context: requestContext(c),
          ...params,
          input: await internalInput(c, c.req.valid("json")),
        }),
      );
    },
  )
  .get("/mailboxes/:mailboxId/messages/:messageId", v("param", mailboxAndIdParamSchema("messageId")), async (c) => {
    const params = internalParams(c, c.req.valid("param")) as {
      mailboxId: string;
      messageId: string;
    };
    return respondMessages(c, messages.getMessage({ context: requestContext(c), ...params }));
  })
  .post("/mailboxes/:mailboxId/messages/:messageId/security-report", v("param", mailboxAndIdParamSchema("messageId")), async (c) =>
    respondPublic(
      c,
      security.reportMessage({
        context: requestContext(c),
        ...internalParams(c, c.req.valid("param") as { mailboxId: string; messageId: string }),
      }),
    ),
  )
  .post(
    "/mailboxes/:mailboxId/messages/:messageId/derive-draft",
    v("param", mailboxAndIdParamSchema("messageId")),
    v("json", deriveDraftFromMessageInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as { mailboxId: string; messageId: string };
      return respondDrafts(
        c,
        drafts.deriveDraftFromMessage({
          context: requestContext(c),
          ...params,
          input: await internalInput(c, c.req.valid("json")),
        }),
      );
    },
  )
  .post(
    "/mailboxes/:mailboxId/scheduled-sends/:scheduledSendId/recovery-draft",
    v("param", mailboxAndIdParamSchema("scheduledSendId")),
    v("json", createDeliveryRecoveryDraftInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as { mailboxId: string; scheduledSendId: string };
      return respondDrafts(
        c,
        drafts.createDeliveryRecoveryDraft({
          context: requestContext(c),
          mailboxId: params.mailboxId,
          deliveryId: params.scheduledSendId,
          input: await internalInput(c, c.req.valid("json")),
        }),
      );
    },
  )
  .get("/mailboxes/:mailboxId/messages/:messageId/inspector", v("param", mailboxAndIdParamSchema("messageId")), async (c) => {
    const params = internalParams(c, c.req.valid("param")) as {
      mailboxId: string;
      messageId: string;
    };
    return respondMessages(c, messageInspector.inspectMessage({ context: requestContext(c), ...params }));
  })
  .get("/mailboxes/:mailboxId/messages/:messageId/source-preview", v("param", mailboxAndIdParamSchema("messageId")), async (c) => {
    const params = internalParams(c, c.req.valid("param")) as {
      mailboxId: string;
      messageId: string;
    };
    return respondMessageSource(c, messageInspector.previewMessageSource({ context: requestContext(c), ...params }));
  })
  .get(
    "/mailboxes/:mailboxId/messages/:messageId/source",
    v("param", mailboxAndIdParamSchema("messageId")),
    v("query", messageSourceQuerySchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        messageId: string;
      };
      const query = await internalInput(c, c.req.valid("query"));
      return attachmentDownloadResponse(
        c,
        await messageInspector.openMessageSource({ context: requestContext(c), ...params }),
        { ...query, inline: false },
        async (expectedBlobId) => {
          const current = await messageInspector.openMessageSource({ context: requestContext(c), ...params });
          if (!current.ok || current.data.blobId !== expectedBlobId) {
            throw Object.assign(new Error("Message source access was revoked during transfer"), { code: "ACCESS_REVOKED" });
          }
        },
      );
    },
  )
  .get(
    "/mailboxes/:mailboxId/messages/:messageId/attachments/:attachmentId",
    v(
      "param",
      z.object({
        mailboxId: ResourceShortIdSchema,
        messageId: ResourceShortIdSchema,
        attachmentId: ResourceShortIdSchema,
      }),
    ),
    v("query", attachmentQuerySchema),
    async (c) => {
      const context = requestContext(c);
      const params = internalParams(c, c.req.valid("param"));
      return attachmentDownloadResponse(
        c,
        await messages.openAttachment({ context, ...params }),
        await internalInput(c, c.req.valid("query")),
        async (expectedBlobId) => {
          const current = await messages.openAttachment({ context, ...params });
          if (!current.ok || current.data.blobId !== expectedBlobId) {
            throw Object.assign(new Error("Attachment access was revoked during transfer"), { code: "ACCESS_REVOKED" });
          }
        },
      );
    },
  )
  .post(
    "/mailboxes/:mailboxId/messages/:messageId/attachments/:attachmentId/links",
    v(
      "param",
      z.object({
        mailboxId: ResourceShortIdSchema,
        messageId: ResourceShortIdSchema,
        attachmentId: ResourceShortIdSchema,
      }),
    ),
    v("json", createAttachmentLinkInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param"));
      return respondPublic(
        c,
        projectAttachmentLinks(
          attachmentLinks.createPublicAttachmentLink({
            context: requestContext(c),
            mailboxId: params.mailboxId,
            sourceKind: "message",
            sourceId: params.messageId,
            attachmentId: params.attachmentId,
            input: await internalInput(c, c.req.valid("json")),
          }),
        ),
      );
    },
  )
  .get("/mailboxes/:mailboxId/attachment-links", v("param", mailboxParamSchema), v("query", cursorQuerySchema), async (c) =>
    respondPublic(
      c,
      projectAttachmentLinks(
        attachmentLinks.listPublicAttachmentLinks(requestContext(c), internalMailboxId(c), await internalInput(c, c.req.valid("query"))),
      ),
    ),
  )
  .delete("/mailboxes/:mailboxId/attachment-links/:linkId", v("param", mailboxAndIdParamSchema("linkId", z.uuid())), async (c) => {
    const params = internalParams(c, c.req.valid("param")) as {
      mailboxId: string;
      linkId: string;
    };
    return respondPublic(
      c,
      attachmentLinks.revokePublicAttachmentLink({
        context: requestContext(c),
        ...params,
      }),
    );
  })
  .post("/mailboxes/:mailboxId/search", v("param", mailboxParamSchema), v("json", searchRequestSchema), async (c) =>
    respondMessages(
      c,
      search.searchMessages({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        request: await internalInput(c, c.req.valid("json")),
      }),
    ),
  )
  .get("/mailboxes/:mailboxId/sender-identities", v("param", mailboxParamSchema), async (c) =>
    respondSenderIdentities(c, senderIdentities.listSenderIdentities(requestContext(c), internalMailboxId(c))),
  )
  .get("/mailboxes/:mailboxId/compose-templates", v("param", mailboxParamSchema), async (c) =>
    respondComposeTemplates(c, composeTemplates.listComposeTemplates(requestContext(c), internalMailboxId(c))),
  )
  .post("/mailboxes/:mailboxId/compose-templates", v("param", mailboxParamSchema), v("json", createComposeTemplateInputSchema), async (c) =>
    respondComposeTemplates(
      c,
      composeTemplates.createComposeTemplate({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        input: await internalInput(c, c.req.valid("json")),
      }),
    ),
  )
  .patch(
    "/mailboxes/:mailboxId/compose-templates/:templateId",
    v("param", mailboxAndIdParamSchema("templateId")),
    v("json", updateComposeTemplateInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        templateId: string;
      };
      return respondComposeTemplates(
        c,
        composeTemplates.updateComposeTemplate({
          context: requestContext(c),
          ...params,
          input: await internalInput(c, c.req.valid("json")),
        }),
      );
    },
  )
  .delete(
    "/mailboxes/:mailboxId/compose-templates/:templateId",
    v("param", mailboxAndIdParamSchema("templateId")),
    v("json", archiveComposeTemplateInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        templateId: string;
      };
      return respondComposeTemplates(
        c,
        composeTemplates.archiveComposeTemplate({
          context: requestContext(c),
          ...params,
          input: await internalInput(c, c.req.valid("json")),
        }),
      );
    },
  )
  .get("/mailboxes/:mailboxId/compose-signature-defaults", v("param", mailboxParamSchema), async (c) =>
    respondPublic(c, composeTemplates.listComposeSignatureDefaults(requestContext(c), internalMailboxId(c))),
  )
  .put(
    "/mailboxes/:mailboxId/sender-identities/:senderIdentityId/compose-signature-default",
    v("param", mailboxAndIdParamSchema("senderIdentityId")),
    v("json", setComposeSignatureDefaultInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        senderIdentityId: string;
      };
      return respondPublic(
        c,
        composeTemplates.setComposeSignatureDefault({
          context: requestContext(c),
          ...params,
          input: await internalInput(c, c.req.valid("json")),
        }),
      );
    },
  )
  .get("/mailboxes/:mailboxId/compose-style", v("param", mailboxParamSchema), async (c) =>
    respondPublic(c, composeTemplates.getMailboxComposeStyle(requestContext(c), internalMailboxId(c))),
  )
  .put("/mailboxes/:mailboxId/compose-style", v("param", mailboxParamSchema), v("json", updateMailboxComposeStyleInputSchema), async (c) =>
    respondPublic(
      c,
      composeTemplates.updateMailboxComposeStyle({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        input: await internalInput(c, c.req.valid("json")),
      }),
    ),
  )
  .post("/mailboxes/:mailboxId/compose-preview", v("param", mailboxParamSchema), v("json", composePreviewInputSchema), async (c) =>
    respondPublic(
      c,
      composeTemplates.previewComposeDraft({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        input: await internalInput(c, c.req.valid("json")),
      }),
    ),
  )
  .post("/mailboxes/:mailboxId/compose-snippet", v("param", mailboxParamSchema), v("json", renderComposeSnippetInputSchema), async (c) =>
    respondPublic(
      c,
      composeTemplates.renderComposeSnippet({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        input: await internalInput(c, c.req.valid("json")),
      }),
    ),
  )
  .post("/mailboxes/:mailboxId/compose-suggestions", v("param", mailboxParamSchema), v("json", composeSuggestionsInputSchema), async (c) =>
    respondPublic(
      c,
      composeTemplates.renderComposeSuggestions({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        input: await internalInput(c, c.req.valid("json")),
      }),
    ),
  )
  .post("/mailboxes/:mailboxId/sender-identities", v("param", mailboxParamSchema), v("json", createSenderIdentityInputSchema), async (c) =>
    respondSenderIdentities(
      c,
      senderIdentities.createSenderIdentity({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        input: await internalInput(c, c.req.valid("json")),
      }),
    ),
  )
  .post(
    "/mailboxes/:mailboxId/sender-identities/default/setup",
    v("param", mailboxParamSchema),
    v("json", defaultSenderSetupInputSchema),
    async (c) =>
      respondSenderIdentities(
        c,
        senderIdentities.setupDefaultSender({
          context: requestContext(c),
          mailboxId: internalMailboxId(c),
          input: await internalInput(c, c.req.valid("json")),
        }),
      ),
  )
  .patch(
    "/mailboxes/:mailboxId/sender-identities/:senderIdentityId",
    v("param", mailboxAndIdParamSchema("senderIdentityId")),
    v("json", updateSenderIdentityInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        senderIdentityId: string;
      };
      return respondSenderIdentities(
        c,
        senderIdentities.updateSenderIdentity({
          context: requestContext(c),
          ...params,
          input: await internalInput(c, c.req.valid("json")),
        }),
      );
    },
  )
  .delete(
    "/mailboxes/:mailboxId/sender-identities/:senderIdentityId",
    v("param", mailboxAndIdParamSchema("senderIdentityId")),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        senderIdentityId: string;
      };
      return respondSenderIdentities(
        c,
        senderIdentities.disableSenderIdentity({
          context: requestContext(c),
          ...params,
        }),
      );
    },
  )
  .post(
    "/mailboxes/:mailboxId/sender-identities/:senderIdentityId/verify",
    v("param", mailboxAndIdParamSchema("senderIdentityId")),
    v("json", verifyIdentitySchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        senderIdentityId: string;
      };
      return respondSenderIdentities(
        c,
        senderIdentities.verifySenderIdentity({
          context: requestContext(c),
          ...params,
          ...(await internalInput(c, c.req.valid("json"))),
        }),
      );
    },
  )
  .get("/mailboxes/:mailboxId/drafts", v("param", mailboxParamSchema), v("query", limitQuerySchema), async (c) =>
    respondDrafts(c, drafts.listDrafts(requestContext(c), internalMailboxId(c), (await internalInput(c, c.req.valid("query"))).limit)),
  )
  .get("/mailboxes/:mailboxId/drafts/:draftId", v("param", mailboxAndIdParamSchema("draftId")), async (c) => {
    const params = internalParams(c, c.req.valid("param")) as {
      mailboxId: string;
      draftId: string;
    };
    return respondDrafts(c, drafts.getDraft(requestContext(c), params.mailboxId, params.draftId));
  })
  .post("/mailboxes/:mailboxId/draft-seeds", v("param", mailboxParamSchema), v("json", prepareDraftSeedInputSchema), async (c) =>
    respondPublic(
      c,
      drafts.prepareDraftSeed({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        origin: (await internalInput(c, c.req.valid("json"))).origin,
      }),
    ),
  )
  .post(
    "/mailboxes/:mailboxId/draft-seeds/materialize",
    v("param", mailboxParamSchema),
    v("json", materializeDraftSeedInputSchema),
    async (c) =>
      respondDrafts(
        c,
        drafts.materializeDraftSeed({
          context: requestContext(c),
          mailboxId: internalMailboxId(c),
          input: await internalInput(c, c.req.valid("json")),
        }),
      ),
  )
  .post("/mailboxes/:mailboxId/drafts", v("param", mailboxParamSchema), v("json", draftContentInputSchema), async (c) =>
    respondDrafts(
      c,
      drafts.createDraft({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        input: await internalInput(c, c.req.valid("json")),
      }),
    ),
  )
  .put("/mailboxes/:mailboxId/drafts/:draftId", v("param", mailboxAndIdParamSchema("draftId")), v("json", updateDraftSchema), async (c) => {
    const params = internalParams(c, c.req.valid("param")) as {
      mailboxId: string;
      draftId: string;
    };
    const input = await internalInput(c, c.req.valid("json"));
    return respondDrafts(
      c,
      drafts.updateDraft({
        context: requestContext(c),
        ...params,
        expectedRevision: input.expectedRevision,
        input: input.draft,
      }),
    );
  })
  .post(
    "/mailboxes/:mailboxId/drafts/:draftId/safety-review",
    v("param", mailboxAndIdParamSchema("draftId")),
    v("json", composeSafetyReviewInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as { mailboxId: string; draftId: string };
      return respondPublic(
        c,
        composeSafety.reviewDraftComposeSafety({
          context: requestContext(c),
          ...params,
          expectedRevision: (await internalInput(c, c.req.valid("json"))).expectedRevision,
        }),
      );
    },
  )
  .get("/mailboxes/:mailboxId/drafts/:draftId/recovery-copies", v("param", mailboxAndIdParamSchema("draftId")), async (c) =>
    respondPublic(
      c,
      drafts.listDraftRecoveryCopies({
        context: requestContext(c),
        ...internalParams(c, c.req.valid("param") as { mailboxId: string; draftId: string }),
      }),
    ),
  )
  .post(
    "/mailboxes/:mailboxId/drafts/:draftId/recovery-copies/:recoveryCopyId/restore",
    v(
      "param",
      z.object({
        mailboxId: ResourceShortIdSchema,
        draftId: ResourceShortIdSchema,
        recoveryCopyId: z.string().uuid(),
      }),
    ),
    v("json", draftRecoveryRestoreSchema),
    async (c) =>
      respondDrafts(
        c,
        drafts.restoreDraftRecoveryCopy({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param")),
          expectedRevision: (await internalInput(c, c.req.valid("json"))).expectedRevision,
          leaseToken: (await internalInput(c, c.req.valid("json"))).leaseToken,
        }),
      ),
  )
  .get("/mailboxes/:mailboxId/drafts/:draftId/lease", v("param", mailboxAndIdParamSchema("draftId")), async (c) =>
    respondPublic(
      c,
      draftLeases.getDraftLease({
        context: requestContext(c),
        ...internalParams(c, c.req.valid("param") as { mailboxId: string; draftId: string }),
      }),
    ),
  )
  .post(
    "/mailboxes/:mailboxId/drafts/:draftId/lease",
    v("param", mailboxAndIdParamSchema("draftId")),
    v("json", acquireDraftLeaseSchema),
    async (c) =>
      respondPublic(
        c,
        draftLeases.acquireDraftLease({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param") as { mailboxId: string; draftId: string }),
          takeover: (await internalInput(c, c.req.valid("json"))).takeover,
        }),
      ),
  )
  .put(
    "/mailboxes/:mailboxId/drafts/:draftId/lease",
    v("param", mailboxAndIdParamSchema("draftId")),
    v("json", draftLeaseTokenSchema),
    async (c) =>
      respondPublic(
        c,
        draftLeases.heartbeatDraftLease({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param") as { mailboxId: string; draftId: string }),
          token: (await internalInput(c, c.req.valid("json"))).token,
        }),
      ),
  )
  .delete(
    "/mailboxes/:mailboxId/drafts/:draftId/lease",
    v("param", mailboxAndIdParamSchema("draftId")),
    v("json", draftLeaseTokenSchema),
    async (c) =>
      respondPublic(
        c,
        draftLeases.releaseDraftLease({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param") as { mailboxId: string; draftId: string }),
          token: (await internalInput(c, c.req.valid("json"))).token,
        }),
      ),
  )
  .post(
    "/mailboxes/:mailboxId/drafts/:draftId/discard",
    v("param", mailboxAndIdParamSchema("draftId")),
    v("json", draftRevisionSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        draftId: string;
      };
      return respondDrafts(
        c,
        drafts.discardDraft({
          context: requestContext(c),
          ...params,
          expectedRevision: (await internalInput(c, c.req.valid("json"))).expectedRevision,
        }),
      );
    },
  )
  .post(
    "/mailboxes/:mailboxId/drafts/:draftId/attachments",
    v("param", mailboxAndIdParamSchema("draftId")),
    v("query", attachmentUploadQuerySchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as {
        mailboxId: string;
        draftId: string;
      };
      const query = await internalInput(c, c.req.valid("query"));
      const contentLength = c.req.header("content-length");
      if (contentLength == null) return respondPublic(c, fail(err.badInput("Attachment Content-Length is required")));
      const expectedSize = Number(contentLength);
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
        return respondPublic(c, fail(err.badInput("Invalid attachment Content-Length")));
      }
      const body = c.req.raw.body;
      if (!body && expectedSize > 0) return respondPublic(c, fail(err.badInput("Attachment body is required")));
      return respondDrafts(
        c,
        draftUploads.uploadDraftAttachmentStream({
          context: requestContext(c),
          ...params,
          expectedRevision: query.expectedRevision,
          filename: query.filename,
          contentType: c.req.header("content-type") || "application/octet-stream",
          byteLength: expectedSize,
          stream: body ? Readable.fromWeb(body as never) : Readable.from([]),
        }),
      );
    },
  )
  .get(
    "/mailboxes/:mailboxId/drafts/:draftId/attachments/:attachmentId",
    v(
      "param",
      z.object({
        mailboxId: ResourceShortIdSchema,
        draftId: ResourceShortIdSchema,
        attachmentId: ResourceShortIdSchema,
      }),
    ),
    v("query", attachmentQuerySchema),
    async (c) => {
      const context = requestContext(c);
      const params = internalParams(c, c.req.valid("param"));
      return attachmentDownloadResponse(
        c,
        await drafts.openDraftAttachment({ context, ...params }),
        await internalInput(c, c.req.valid("query")),
        async (expectedBlobId) => {
          const current = await drafts.openDraftAttachment({
            context,
            ...params,
          });
          if (!current.ok || current.data.blobId !== expectedBlobId) {
            throw Object.assign(new Error("Draft attachment access was revoked during transfer"), { code: "ACCESS_REVOKED" });
          }
        },
      );
    },
  )
  .delete(
    "/mailboxes/:mailboxId/drafts/:draftId/attachments/:attachmentId",
    v(
      "param",
      z.object({
        mailboxId: ResourceShortIdSchema,
        draftId: ResourceShortIdSchema,
        attachmentId: ResourceShortIdSchema,
      }),
    ),
    v("query", draftRevisionSchema),
    async (c) =>
      respondDrafts(
        c,
        drafts.removeDraftAttachment({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param")),
          expectedRevision: (await internalInput(c, c.req.valid("query"))).expectedRevision,
        }),
      ),
  )
  .post(
    "/mailboxes/:mailboxId/drafts/:draftId/attachments/:attachmentId/links",
    v(
      "param",
      z.object({
        mailboxId: ResourceShortIdSchema,
        draftId: ResourceShortIdSchema,
        attachmentId: ResourceShortIdSchema,
      }),
    ),
    v("json", createAttachmentLinkInputSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param"));
      return respondPublic(
        c,
        projectAttachmentLinks(
          attachmentLinks.createPublicAttachmentLink({
            context: requestContext(c),
            mailboxId: params.mailboxId,
            sourceKind: "draft",
            sourceId: params.draftId,
            attachmentId: params.attachmentId,
            input: await internalInput(c, c.req.valid("json")),
          }),
        ),
      );
    },
  )
  .get("/mailboxes/:mailboxId/drafts/:draftId/attachment-uploads", v("param", mailboxAndIdParamSchema("draftId")), async (c) =>
    respondPublic(
      c,
      draftUploads.listDraftAttachmentUploads({
        context: requestContext(c),
        ...internalParams(c, c.req.valid("param") as { mailboxId: string; draftId: string }),
      }),
    ),
  )
  .post(
    "/mailboxes/:mailboxId/drafts/:draftId/attachment-uploads",
    v("param", mailboxAndIdParamSchema("draftId")),
    v("json", createDraftAttachmentUploadSchema),
    async (c) =>
      respondPublic(
        c,
        draftUploads.createDraftAttachmentUpload({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param") as { mailboxId: string; draftId: string }),
          input: await internalInput(c, c.req.valid("json")),
        }),
      ),
  )
  .get(
    "/mailboxes/:mailboxId/drafts/:draftId/attachment-uploads/:uploadId",
    v(
      "param",
      z.object({
        mailboxId: ResourceShortIdSchema,
        draftId: ResourceShortIdSchema,
        uploadId: z.string().uuid(),
      }),
    ),
    async (c) =>
      respondPublic(
        c,
        draftUploads.getDraftAttachmentUpload({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param")),
        }),
      ),
  )
  .patch(
    "/mailboxes/:mailboxId/drafts/:draftId/attachment-uploads/:uploadId",
    v(
      "param",
      z.object({
        mailboxId: ResourceShortIdSchema,
        draftId: ResourceShortIdSchema,
        uploadId: z.string().uuid(),
      }),
    ),
    v("query", attachmentChunkQuerySchema),
    async (c) => {
      const body = await readBoundedBody(c.req.raw.body, draftUploads.DRAFT_UPLOAD_CHUNK_BYTES);
      if (!body.ok) return respondPublic(c, body);
      return respondPublic(
        c,
        draftUploads.appendDraftAttachmentUpload({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param")),
          offset: (await internalInput(c, c.req.valid("query"))).offset,
          bytes: body.data,
        }),
      );
    },
  )
  .post(
    "/mailboxes/:mailboxId/drafts/:draftId/attachment-uploads/:uploadId/finalize",
    v(
      "param",
      z.object({
        mailboxId: ResourceShortIdSchema,
        draftId: ResourceShortIdSchema,
        uploadId: z.string().uuid(),
      }),
    ),
    v("json", draftRevisionSchema),
    async (c) =>
      respondDrafts(
        c,
        draftUploads.finalizeDraftAttachmentUpload({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param")),
          expectedRevision: (await internalInput(c, c.req.valid("json"))).expectedRevision,
        }),
      ),
  )
  .delete(
    "/mailboxes/:mailboxId/drafts/:draftId/attachment-uploads/:uploadId",
    v(
      "param",
      z.object({
        mailboxId: ResourceShortIdSchema,
        draftId: ResourceShortIdSchema,
        uploadId: z.string().uuid(),
      }),
    ),
    async (c) =>
      respondPublic(
        c,
        draftUploads.cancelDraftAttachmentUpload({
          context: requestContext(c),
          ...internalParams(c, c.req.valid("param")),
        }),
      ),
  )
  .post("/mailboxes/:mailboxId/commands", v("param", mailboxParamSchema), v("json", mailCommandInputSchema), async (c) =>
    respondCommands(
      c,
      commands.createMailCommand({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        input: await internalCommandInput(c, c.req.valid("json")),
      }),
    ),
  )
  .post("/mailboxes/:mailboxId/operator-actions", v("param", mailboxParamSchema), v("json", maintenanceCommandInputSchema), async (c) =>
    respondCommands(
      c,
      commands.createMaintenanceCommand({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        input: await internalInput(c, c.req.valid("json")),
      }),
    ),
  )
  .get("/mailboxes/:mailboxId/commands", v("param", mailboxParamSchema), v("query", limitQuerySchema), async (c) =>
    respondCommands(
      c,
      commands.listCommands(requestContext(c), internalMailboxId(c), (await internalInput(c, c.req.valid("query"))).limit),
    ),
  )
  .get("/mailboxes/:mailboxId/commands/:commandId", v("param", mailboxAndIdParamSchema("commandId", z.uuid())), async (c) => {
    const params = internalParams(c, c.req.valid("param")) as {
      mailboxId: string;
      commandId: string;
    };
    return respondCommands(c, commands.getCommand(requestContext(c), params.mailboxId, params.commandId));
  })
  .post("/mailboxes/:mailboxId/commands/:commandId/cancel", v("param", mailboxAndIdParamSchema("commandId", z.uuid())), async (c) => {
    const params = internalParams(c, c.req.valid("param")) as {
      mailboxId: string;
      commandId: string;
    };
    return respondPublic(c, cancelSendCommand({ context: requestContext(c), ...params }));
  })
  .get("/mailboxes/:mailboxId/scheduled-sends", v("param", mailboxParamSchema), v("query", cursorQuerySchema), async (c) =>
    respondDeliveries(
      c,
      scheduledSends.listScheduledSends({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        ...(await internalInput(c, c.req.valid("query"))),
      }),
    ),
  )
  .post(
    "/mailboxes/:mailboxId/scheduled-sends/:scheduledSendId/cancel",
    v("param", mailboxAndIdParamSchema("scheduledSendId")),
    v("json", cancelScheduledSendInputSchema),
    async (c) =>
      respondDeliveries(
        c,
        scheduledSends.cancelScheduledSend({
          context: requestContext(c),
          ...internalParams(
            c,
            c.req.valid("param") as {
              mailboxId: string;
              scheduledSendId: string;
            },
          ),
          input: await internalInput(c, c.req.valid("json")),
        }),
      ),
  )
  .route("/", workflowRoutes);

const adminApi = new Hono<MailApiContext>()
  .use("/admin/*", auth.requireRole("admin"))
  .use("/admin/mailboxes/:mailboxId", resolveMailboxParam)
  .use("/admin/mailboxes/:mailboxId/*", resolveMailboxParam)
  .get("/admin/operations", v("query", platformOperationsQuerySchema), async (c) =>
    respondPublic(c, operations.getPlatformMailOperations(requestContext(c), c.req.valid("query"))),
  )
  .get("/admin/mailboxes/:mailboxId/operations", v("param", mailboxParamSchema), async (c) =>
    respondPublic(c, operations.getPlatformMailboxOperation(requestContext(c), internalMailboxId(c))),
  )
  .get("/admin/mailboxes/:mailboxId/access", v("param", mailboxParamSchema), async (c) =>
    respondPublic(c, mailboxAccess.listMailboxAccessAsPlatformAdmin(requestContext(c), internalMailboxId(c))),
  )
  .post("/admin/mailboxes/:mailboxId/access", v("param", mailboxParamSchema), v("json", GrantAccessSchema), async (c) => {
    const input = await internalInput(c, c.req.valid("json"));
    if (input.permission === "none") return respondPublic(c, fail(err.badInput("Access permission cannot be none")));
    return respondPublic(
      c,
      mailboxAccess.grantMailboxAccessAsPlatformAdmin({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        principal: input.principal,
        permission: input.permission,
      }),
    );
  })
  .patch(
    "/admin/mailboxes/:mailboxId/access/:accessId",
    v("param", mailboxAndIdParamSchema("accessId", z.uuid())),
    v("json", UpdateAccessSchema),
    async (c) => {
      const params = internalParams(c, c.req.valid("param")) as { mailboxId: string; accessId: string };
      const { permission } = await internalInput(c, c.req.valid("json"));
      if (permission === "none") return respondPublic(c, fail(err.badInput("Use DELETE to revoke access")));
      return respondPublic(
        c,
        mailboxAccess.updateMailboxAccessAsPlatformAdmin({
          context: requestContext(c),
          ...params,
          permission,
        }),
      );
    },
  )
  .delete("/admin/mailboxes/:mailboxId/access/:accessId", v("param", mailboxAndIdParamSchema("accessId", z.uuid())), async (c) => {
    const params = internalParams(c, c.req.valid("param")) as { mailboxId: string; accessId: string };
    return respondPublic(
      c,
      mailboxAccess.revokeMailboxAccessAsPlatformAdmin({
        context: requestContext(c),
        ...params,
      }),
    );
  })
  .get("/admin/storage", async (c) => respondPublic(c, storageObservability.getMailStorageSummary(requestContext(c))))
  .post("/admin/storage/reconcile", async (c) => respondPublic(c, storageObservability.requestMailStorageReconciliation(requestContext(c))))
  .get("/admin/security/reports", v("query", mailSecurityListQuerySchema), async (c) =>
    respondPublic(c, security.listReports(requestContext(c), c.req.valid("query"))),
  )
  .patch(
    "/admin/security/reports/:reportId",
    v("param", z.object({ reportId: z.string().uuid() })),
    v("json", resolveMailSecurityReportInputSchema),
    async (c) =>
      respondPublic(
        c,
        security.resolveReport({
          context: requestContext(c),
          reportId: c.req.valid("param").reportId,
          ...(await internalInput(c, c.req.valid("json"))),
        }),
      ),
  )
  .get("/admin/security/policies", async (c) => respondPublic(c, security.listPolicies(requestContext(c))))
  .post("/admin/security/policies", v("json", createMailSecurityPolicyInputSchema), async (c) =>
    respondPublic(c, security.createPolicy({ context: requestContext(c), input: c.req.valid("json") })),
  )
  .patch(
    "/admin/security/policies/:policyId",
    v("param", z.object({ policyId: z.string().uuid() })),
    v("json", updateMailSecurityPolicyInputSchema),
    async (c) =>
      respondPublic(
        c,
        security.updatePolicy({ context: requestContext(c), policyId: c.req.valid("param").policyId, input: c.req.valid("json") }),
      ),
  )
  .delete("/admin/security/policies/:policyId", v("param", z.object({ policyId: z.string().uuid() })), async (c) =>
    respondPublic(c, security.deletePolicy(requestContext(c), c.req.valid("param").policyId)),
  )
  .get("/admin/security/protected-identities", async (c) => respondPublic(c, security.listProtectedIdentities(requestContext(c))))
  .post("/admin/security/protected-identities", v("json", createMailProtectedIdentityInputSchema), async (c) =>
    respondPublic(c, security.createProtectedIdentity({ context: requestContext(c), input: c.req.valid("json") })),
  )
  .delete("/admin/security/protected-identities/:identityId", v("param", z.object({ identityId: z.string().uuid() })), async (c) =>
    respondPublic(c, security.deleteProtectedIdentity(requestContext(c), c.req.valid("param").identityId)),
  )
  .get("/admin/security/settings", async (c) => respondPublic(c, security.getSettings(requestContext(c))))
  .patch("/admin/security/settings", v("json", updateMailSecuritySettingsInputSchema), async (c) =>
    respondPublic(c, security.updateSettings({ context: requestContext(c), ...c.req.valid("json") })),
  );

const authenticatedApi = new Hono<MailApiContext>()
  .route("/", providerOAuthApi)
  .route("/", resourceRoutes)
  .route("/", adminApi)
  .route("/", mailOperationsApi);

const api = new Hono<MailApiContext>()
  .use(rateLimit())
  .route("/ws", wsRoutes)
  .use(auth.requireRole("authenticated"))
  .route("/", authenticatedApi);

export default api;
export type ApiType = typeof api;
