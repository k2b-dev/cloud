import { err, fail } from "@k2b/stdlib";
import { getLocale, v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import {
  automaticReplyPreviewInputSchema,
  createAutomaticReplySetupSchema,
  ResourceShortIdSchema,
  updateAutomaticReplySetupSchema,
} from "../contracts";
import { automaticReplyConfigurations, type MailRequestContext, publicResources } from "../service";
import {
  internalMailboxId,
  internalParams,
  type MailApiContext,
  mailboxParamSchema,
  resolveMailboxResourceParam,
  resolvePublicRelations,
  respondPublic,
} from "./public-resource-boundary";

const automaticReplyParamSchema = mailboxParamSchema.extend({ configurationId: ResourceShortIdSchema });
const requestContext = (c: Context<MailApiContext>): MailRequestContext => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  requestId: c.req.header("x-request-id") ?? null,
});

const resolveAutomaticReplyParam = resolveMailboxResourceParam(
  "automaticReplyConfigurations",
  "configurationId",
  "Automatic reply configuration",
);

const projectAutomaticReplySetup = async (
  resultPromise:
    | ReturnType<typeof automaticReplyConfigurations.createAutomaticReplySetup>
    | ReturnType<typeof automaticReplyConfigurations.updateAutomaticReplySetup>,
) => {
  const result = await resultPromise;
  if (!result.ok) return result;
  const ids = await publicResources.publicIds("automaticReplyConfigurations", [result.data.automaticReply.id]);
  return {
    ok: true as const,
    data: {
      ...result.data,
      automaticReply: {
        ...result.data.automaticReply,
        id: publicResources.requirePublicId(ids, result.data.automaticReply.id),
      },
    },
  };
};

export default new Hono<MailApiContext>()
  .get("/mailboxes/:mailboxId/automatic-replies", v("param", mailboxParamSchema), async (c) =>
    respondPublic(
      c,
      automaticReplyConfigurations.listAutomaticReplyConfigurations(requestContext(c), internalMailboxId(c)),
      "automaticReplyConfigurations",
    ),
  )
  .post(
    "/mailboxes/:mailboxId/automatic-replies",
    v("param", mailboxParamSchema),
    v("json", createAutomaticReplySetupSchema),
    async (c) => {
      const input = await resolvePublicRelations(internalMailboxId(c), c.req.valid("json"));
      if (!input) return respondPublic(c, fail(err.notFound("Mail resource")));
      return respondPublic(
        c,
        projectAutomaticReplySetup(
          automaticReplyConfigurations.createAutomaticReplySetup({
            context: requestContext(c),
            mailboxId: internalMailboxId(c),
            input,
          }),
        ),
      );
    },
  )
  .post(
    "/mailboxes/:mailboxId/automatic-replies/preview",
    v("param", mailboxParamSchema),
    v("json", automaticReplyPreviewInputSchema),
    async (c) => {
      const input = await resolvePublicRelations(internalMailboxId(c), c.req.valid("json"));
      if (!input) return respondPublic(c, fail(err.notFound("Mail resource")));
      return respondPublic(
        c,
        automaticReplyConfigurations.previewAutomaticReply({
          context: requestContext(c),
          mailboxId: internalMailboxId(c),
          input,
          locale: getLocale(c),
        }),
      );
    },
  )
  .patch(
    "/mailboxes/:mailboxId/automatic-replies/:configurationId",
    resolveAutomaticReplyParam,
    v("param", automaticReplyParamSchema),
    v("json", updateAutomaticReplySetupSchema),
    async (c) => {
      const input = await resolvePublicRelations(internalMailboxId(c), c.req.valid("json"));
      if (!input) return respondPublic(c, fail(err.notFound("Mail resource")));
      return respondPublic(
        c,
        projectAutomaticReplySetup(
          automaticReplyConfigurations.updateAutomaticReplySetup({
            context: requestContext(c),
            ...internalParams(c, c.req.valid("param")),
            input,
          }),
        ),
      );
    },
  );
