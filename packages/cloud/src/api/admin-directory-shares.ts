import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { PaginationQuerySchema, parsePagination } from "../contracts";
import { type AuthContext, auth, expectUserBackedActor, respond, v } from "../server";
import { noTransform } from "../server/middleware/no-transform";
import { DirectorySharePrincipalSchema, directoryShares } from "../services/accounts/directory-shares";

const Recipient = z.object({ recipientId: z.uuid() });
const Share = Recipient.extend({ id: z.uuid() });
const routes = new Hono<AuthContext>()
  .use("*", noTransform(), auth.requireRole("admin"))
  .get(
    "/:recipientId",
    describeRoute({ tags: ["Service accounts"], summary: "List exact directory entries shared with a machine account" }),
    v("param", Recipient),
    v("query", PaginationQuerySchema),
    async (c) => {
      const pagination = parsePagination(c.req.valid("query"));
      return respond(
        c,
        directoryShares.list({
          actor: expectUserBackedActor(c),
          recipientId: c.req.valid("param").recipientId,
          page: pagination.page,
          perPage: pagination.perPage,
        }),
      );
    },
  )
  .post(
    "/:recipientId",
    describeRoute({ tags: ["Service accounts"], summary: "Share one directory entry with a machine account" }),
    v("param", Recipient),
    v("json", z.object({ principal: DirectorySharePrincipalSchema }).strict()),
    (c) =>
      respond(
        c,
        directoryShares.grant({
          actor: expectUserBackedActor(c),
          recipientId: c.req.valid("param").recipientId,
          principal: c.req.valid("json").principal,
        }),
        201,
      ),
  )
  .delete(
    "/:recipientId/:id",
    describeRoute({ tags: ["Service accounts"], summary: "Revoke a machine account's directory share" }),
    v("param", Share),
    (c) => respond(c, directoryShares.revoke({ actor: expectUserBackedActor(c), ...c.req.valid("param") })),
  );
export default routes;
