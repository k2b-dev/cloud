import { v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  conversationReferencePreviewInputSchema,
  ensureConversationReferenceSchema,
  putConversationReferenceConfigurationSchema,
  ResourceShortIdSchema,
} from "../contracts";
import { conversationReferences, type MailRequestContext } from "../service";
import {
  internalMailboxId,
  internalParams,
  type MailApiContext,
  mailboxParamSchema,
  resolveMailboxResourceParam,
  respondPublic,
} from "./public-resource-boundary";

const conversationParamSchema = mailboxParamSchema.extend({ conversationId: ResourceShortIdSchema });
const referenceLookupSchema = z.object({ value: z.string().trim().min(1).max(160) });
const requestContext = (c: Context<MailApiContext>): MailRequestContext => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  requestId: c.req.header("x-request-id") ?? null,
});

const resolveConversationParam = resolveMailboxResourceParam("conversations", "conversationId", "Conversation");

const withoutInternalReferenceId = <T extends { id: string }>(reference: T): Omit<T, "id"> => {
  const { id: _id, ...publicReference } = reference;
  return publicReference;
};

const projectConversationReferences = async (resultPromise: ReturnType<typeof conversationReferences.listConversationReferences>) => {
  const result = await resultPromise;
  if (!result.ok) return result;
  return { ok: true as const, data: result.data.map(withoutInternalReferenceId) };
};

const projectConversationReferenceResult = async (
  resultPromise:
    | ReturnType<typeof conversationReferences.findConversationByReference>
    | ReturnType<typeof conversationReferences.ensureConversationReference>,
) => {
  const result = await resultPromise;
  if (!result.ok) return result;
  return {
    ok: true as const,
    data: { ...result.data, reference: withoutInternalReferenceId(result.data.reference) },
  };
};

export default new Hono<MailApiContext>()
  .get("/mailboxes/:mailboxId/reference-number-configuration", v("param", mailboxParamSchema), async (c) =>
    respondPublic(c, conversationReferences.getConversationReferenceConfiguration(requestContext(c), internalMailboxId(c))),
  )
  .post(
    "/mailboxes/:mailboxId/reference-number-configuration/preview",
    v("param", mailboxParamSchema),
    v("json", conversationReferencePreviewInputSchema),
    async (c) =>
      respondPublic(
        c,
        conversationReferences.previewConversationReference({
          context: requestContext(c),
          mailboxId: internalMailboxId(c),
          pattern: c.req.valid("json").pattern,
        }),
      ),
  )
  .put(
    "/mailboxes/:mailboxId/reference-number-configuration",
    v("param", mailboxParamSchema),
    v("json", putConversationReferenceConfigurationSchema),
    async (c) =>
      respondPublic(
        c,
        conversationReferences.putConversationReferenceConfiguration({
          context: requestContext(c),
          mailboxId: internalMailboxId(c),
          input: c.req.valid("json"),
        }),
      ),
  )
  .get("/mailboxes/:mailboxId/conversations/by-reference", v("param", mailboxParamSchema), v("query", referenceLookupSchema), async (c) =>
    respondPublic(
      c,
      projectConversationReferenceResult(
        conversationReferences.findConversationByReference({
          context: requestContext(c),
          mailboxId: internalMailboxId(c),
          value: c.req.valid("query").value,
        }),
      ),
    ),
  )
  .get(
    "/mailboxes/:mailboxId/conversations/:conversationId/references",
    resolveConversationParam,
    v("param", conversationParamSchema),
    async (c) =>
      respondPublic(
        c,
        projectConversationReferences(
          conversationReferences.listConversationReferences({
            context: requestContext(c),
            ...internalParams(c, c.req.valid("param")),
          }),
        ),
      ),
  )
  .post(
    "/mailboxes/:mailboxId/conversations/:conversationId/references",
    resolveConversationParam,
    v("param", conversationParamSchema),
    v("json", ensureConversationReferenceSchema),
    async (c) =>
      respondPublic(
        c,
        projectConversationReferenceResult(
          conversationReferences.ensureConversationReference({
            context: requestContext(c),
            ...internalParams(c, c.req.valid("param")),
            input: c.req.valid("json"),
          }),
        ),
      ),
  );
