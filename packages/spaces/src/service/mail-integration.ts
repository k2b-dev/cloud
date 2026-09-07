import { getCapabilityCatalogApp, invokeCapabilityWithDataSchema } from "@valentinkolb/cloud/capabilities/server";
import type { CapabilityResult } from "@valentinkolb/cloud/contracts";
import { z } from "zod";
import {
  type MailEventInvitationDraft,
  type MailEventInvitationDraftInput,
  MailEventInvitationDraftInputSchema,
  type MailInvitationMailbox,
} from "../integration";

const REQUIRED_MAIL_QUERIES = ["mailbox.list", "mailbox.identity.list"] as const;
const REQUIRED_MAIL_ACTIONS = ["draft.create"] as const;

export type MailIntegrationRequest = {
  cookie?: string | null;
  authorization?: string | null;
  requestId?: string | null;
  traceparent?: string | null;
  tracestate?: string | null;
  signal?: AbortSignal;
};

type IntegrationFailure = { ok: false; code: string; message: string; status: number };
type IntegrationResult<T> = { ok: true; data: T } | IntegrationFailure;
type CapabilityFailure = { code: string; message: string; status: number };

const mailResourceIdSchema = z.string().regex(/^[0-9A-Za-z]{6}$/);
const mailboxListSchema = z
  .array(z.object({ ref: z.object({ type: z.literal("mail.mailbox"), id: mailResourceIdSchema }), title: z.string().min(1) }).passthrough())
  .max(100);
const senderIdentityListSchema = z
  .array(
    z
      .object({
        ref: z.object({ type: z.literal("mail.sender-identity"), id: mailResourceIdSchema }),
        label: z.string().min(1),
        displayName: z.string(),
        fromAddress: z.email(),
        isDefault: z.boolean(),
        status: z.enum(["unverified", "verified", "rejected"]),
      })
      .passthrough(),
  )
  .max(100);
const draftDataSchema = z.object({ id: mailResourceIdSchema }).passthrough();

export const isMailInvitationIntegrationAvailable = async (): Promise<boolean> => {
  try {
    const catalog = await getCapabilityCatalogApp("mail");
    if (!catalog.ok || !catalog.data) return false;
    const queries = new Set(catalog.data.manifest.queries.map((operation) => operation.localId));
    const actions = new Set(catalog.data.manifest.actions.map((operation) => operation.localId));
    return REQUIRED_MAIL_QUERIES.every((id) => queries.has(id)) && REQUIRED_MAIL_ACTIONS.every((id) => actions.has(id));
  } catch {
    return false;
  }
};

export const projectMailCapabilityError = (error: CapabilityFailure): IntegrationFailure => {
  const unavailable = error.code === "APP_UNAVAILABLE" || error.code === "CAPABILITY_NOT_FOUND";
  return {
    ok: false,
    code: error.code,
    message: error.message,
    status: unavailable ? 503 : error.status,
  };
};

const callMailCapability = async <T>(params: {
  kind: "query" | "action";
  capabilityId: string;
  request: MailIntegrationRequest;
  dataSchema: z.ZodType<T>;
  input: unknown;
  idempotencyKey?: string;
}): Promise<IntegrationResult<CapabilityResult<T>>> => {
  const result = await invokeCapabilityWithDataSchema(
    {
      appId: "mail",
      capabilityId: params.capabilityId,
      kind: params.kind,
      input: params.input,
      idempotencyKey: params.idempotencyKey,
    },
    params.dataSchema,
    params.request,
  );
  if (!result.ok) return projectMailCapabilityError(result.error);
  return { ok: true, data: result.data };
};

const listIdentities = async (mailboxId: string, request: MailIntegrationRequest) => {
  const identities: z.infer<typeof senderIdentityListSchema> = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  while (identities.length < 100) {
    const page = await callMailCapability({
      kind: "query",
      capabilityId: "mailbox.identity.list",
      request,
      dataSchema: senderIdentityListSchema,
      input: { mailboxId, limit: 50, ...(cursor ? { cursor } : {}) },
    });
    if (!page.ok) return page;
    identities.push(...page.data.data);
    if (identities.length > 100) break;
    if (!page.data.page?.hasMore) return { ok: true as const, data: { data: identities } };
    const nextCursor = page.data.page.nextCursor;
    if (page.data.data.length === 0 || !nextCursor || seenCursors.has(nextCursor)) {
      return { ok: false as const, code: "INVALID_APP_RESPONSE", message: "Invalid sender identity continuation", status: 502 };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return { ok: false as const, code: "RESULT_TOO_LARGE", message: "Too many sender identities for the invitation picker", status: 422 };
};

export const listInvitationMailboxes = async (request: MailIntegrationRequest): Promise<IntegrationResult<MailInvitationMailbox[]>> => {
  const mailboxes: z.infer<typeof mailboxListSchema> = [];
  let cursor: string | undefined;
  // The existing invitation picker accepts at most 200 mailboxes.
  const seenCursors = new Set<string>();
  while (mailboxes.length < 200) {
    const page = await callMailCapability({
      kind: "query",
      capabilityId: "mailbox.list",
      request,
      dataSchema: mailboxListSchema,
      input: { minimumPermission: "write", limit: 100, ...(cursor ? { cursor } : {}) },
    });
    if (!page.ok) return page;
    mailboxes.push(...page.data.data);
    if (mailboxes.length > 200)
      return { ok: false, code: "RESULT_TOO_LARGE", message: "Too many mailboxes for the invitation picker", status: 422 };
    if (!page.data.page?.hasMore) {
      cursor = undefined;
      break;
    }
    const nextCursor = page.data.page.nextCursor;
    if (page.data.data.length === 0 || !nextCursor || seenCursors.has(nextCursor)) {
      return { ok: false, code: "INVALID_APP_RESPONSE", message: "Invalid mailbox continuation", status: 502 };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  if (cursor) return { ok: false, code: "RESULT_TOO_LARGE", message: "Too many mailboxes for the invitation picker", status: 422 };
  const resolved: MailInvitationMailbox[] = [];
  let firstIdentityFailure: IntegrationResult<never> | null = null;
  const identityLookupConcurrency = 8;
  for (let offset = 0; offset < mailboxes.length; offset += identityLookupConcurrency) {
    const group = await Promise.all(
      mailboxes.slice(offset, offset + identityLookupConcurrency).map(async (mailbox) => {
        const identities = await listIdentities(mailbox.ref.id, request);
        if (!identities.ok) {
          firstIdentityFailure ??= identities;
          return null;
        }
        const verified = identities.data.data.filter((candidate) => candidate.status === "verified");
        return verified.length > 0
          ? {
              id: mailbox.ref.id,
              name: mailbox.title,
              identities: verified.map((identity) => ({
                id: identity.ref.id,
                label: identity.label,
                from: { name: identity.displayName || null, address: identity.fromAddress },
                isDefault: identity.isDefault,
              })),
            }
          : null;
      }),
    );
    resolved.push(...group.filter((item): item is MailInvitationMailbox => item !== null));
  }
  if (firstIdentityFailure) return firstIdentityFailure;
  return { ok: true, data: resolved };
};

export const createInvitationDraft = async (
  rawInput: MailEventInvitationDraftInput,
  request: MailIntegrationRequest,
): Promise<IntegrationResult<MailEventInvitationDraft>> => {
  const input = MailEventInvitationDraftInputSchema.parse(rawInput);
  const identities = await listIdentities(input.mailboxId, request);
  if (!identities.ok) return identities;
  const identity = identities.data.data.find((candidate) => candidate.ref.id === input.senderIdentityId && candidate.status === "verified");
  if (!identity) return { ok: false, code: "FORBIDDEN", message: "The selected verified sender identity is unavailable", status: 403 };
  const created = await callMailCapability({
    kind: "action",
    capabilityId: "draft.create",
    request,
    dataSchema: draftDataSchema,
    idempotencyKey: input.idempotencyKey,
    input: {
      mailboxId: input.mailboxId,
      senderIdentityId: input.senderIdentityId,
      to: input.to,
      subject: input.subject,
      body: input.body,
      format: "plain",
      attachments: [
        {
          filename: "invitation.ics",
          contentType: `text/calendar; method=${input.calendar.includes("METHOD:CANCEL") ? "CANCEL" : "REQUEST"}; charset=utf-8`,
          base64: Buffer.from(input.calendar, "utf8").toString("base64"),
        },
      ],
    },
  });
  return created.ok ? { ok: true, data: { mailboxId: input.mailboxId, draftId: created.data.data.id } } : created;
};
