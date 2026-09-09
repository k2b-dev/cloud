import { err, fail } from "@k2b/stdlib";
import { v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import {
  addConversationLocalTagsSchema,
  createLocalTagSchema,
  deleteLocalTagSchema,
  ResourceShortIdSchema,
  setConversationLocalTagsSchema,
  updateLocalTagSchema,
} from "../contracts";
import { localTags, type MailRequestContext, publicResources } from "../service";
import {
  internalMailboxId,
  internalParams,
  type MailApiContext,
  mailboxParamSchema,
  resolveMailboxResourceParam,
  resolvePublicRelations,
  respondPublic,
} from "./public-resource-boundary";

const tagParamSchema = mailboxParamSchema.extend({ tagId: ResourceShortIdSchema });
const conversationParamSchema = mailboxParamSchema.extend({ conversationId: ResourceShortIdSchema });
const requestContext = (c: Context<MailApiContext>): MailRequestContext => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  requestId: c.req.header("x-request-id") ?? null,
});

const resolveTagParam = resolveMailboxResourceParam("tags", "tagId", "Tag");
const resolveConversationParam = resolveMailboxResourceParam("conversations", "conversationId", "Conversation");

const projectConversationLocalTags = async (
  resultPromise: ReturnType<typeof localTags.getConversationLocalTags> | ReturnType<typeof localTags.setConversationLocalTags>,
) => {
  const result = await resultPromise;
  if (!result.ok) return result;
  const ids = await publicResources.publicIds(
    "tags",
    result.data.tags.map((tag) => tag.id),
  );
  return {
    ok: true as const,
    data: { ...result.data, tags: result.data.tags.map((tag) => ({ ...tag, id: publicResources.requirePublicId(ids, tag.id) })) },
  };
};

const projectBulkConversationTags = async (resultPromise: ReturnType<typeof localTags.addConversationLocalTags>) => {
  const result = await resultPromise;
  if (!result.ok) return result;
  const conversations = await publicResources.publicIds("conversations", [
    ...result.data.updatedConversationIds,
    ...result.data.unchangedConversationIds,
  ]);
  return {
    ok: true as const,
    data: {
      updatedConversationIds: result.data.updatedConversationIds.map((id) => publicResources.requirePublicId(conversations, id)),
      unchangedConversationIds: result.data.unchangedConversationIds.map((id) => publicResources.requirePublicId(conversations, id)),
    },
  };
};

export const projectDeletedLocalTag = async (resultPromise: ReturnType<typeof localTags.deleteLocalTag>, publicTagId: string) => {
  const result = await resultPromise;
  return result.ok ? { ok: true as const, data: { id: publicTagId } } : result;
};

const localTagRoutes = new Hono<MailApiContext>()
  .get("/mailboxes/:mailboxId/local-tags", v("param", mailboxParamSchema), async (c) =>
    respondPublic(c, localTags.listLocalTags(requestContext(c), internalMailboxId(c)), "tags"),
  )
  .post("/mailboxes/:mailboxId/local-tags", v("param", mailboxParamSchema), v("json", createLocalTagSchema), async (c) =>
    respondPublic(
      c,
      localTags.createLocalTag({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        input: c.req.valid("json"),
      }),
      "tags",
    ),
  )
  .patch(
    "/mailboxes/:mailboxId/local-tags/:tagId",
    resolveTagParam,
    v("param", tagParamSchema),
    v("json", updateLocalTagSchema),
    async (c) =>
      respondPublic(
        c,
        localTags.updateLocalTag({ context: requestContext(c), ...internalParams(c, c.req.valid("param")), input: c.req.valid("json") }),
        "tags",
      ),
  )
  .delete(
    "/mailboxes/:mailboxId/local-tags/:tagId",
    resolveTagParam,
    v("param", tagParamSchema),
    v("json", deleteLocalTagSchema),
    async (c) =>
      respondPublic(
        c,
        projectDeletedLocalTag(
          localTags.deleteLocalTag({ context: requestContext(c), ...internalParams(c, c.req.valid("param")), input: c.req.valid("json") }),
          c.req.valid("param").tagId,
        ),
      ),
  )
  .get(
    "/mailboxes/:mailboxId/conversations/:conversationId/local-tags",
    resolveConversationParam,
    v("param", conversationParamSchema),
    async (c) =>
      respondPublic(
        c,
        projectConversationLocalTags(
          localTags.getConversationLocalTags({ context: requestContext(c), ...internalParams(c, c.req.valid("param")) }),
        ),
      ),
  )
  .post(
    "/mailboxes/:mailboxId/conversations/local-tags",
    v("param", mailboxParamSchema),
    v("json", addConversationLocalTagsSchema),
    async (c) => {
      const input = await resolvePublicRelations(internalMailboxId(c), c.req.valid("json"));
      if (!input) return respondPublic(c, fail(err.notFound("Mail resource")));
      return respondPublic(
        c,
        projectBulkConversationTags(
          localTags.addConversationLocalTags({
            context: requestContext(c),
            mailboxId: internalMailboxId(c),
            input,
          }),
        ),
      );
    },
  )
  .put(
    "/mailboxes/:mailboxId/conversations/:conversationId/local-tags",
    resolveConversationParam,
    v("param", conversationParamSchema),
    v("json", setConversationLocalTagsSchema),
    async (c) => {
      const input = await resolvePublicRelations(internalMailboxId(c), c.req.valid("json"));
      if (!input) return respondPublic(c, fail(err.notFound("Mail resource")));
      return respondPublic(
        c,
        projectConversationLocalTags(
          localTags.setConversationLocalTags({ context: requestContext(c), ...internalParams(c, c.req.valid("param")), input }),
        ),
      );
    },
  );

export default localTagRoutes;
