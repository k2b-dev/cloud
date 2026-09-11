import { Hono } from "hono";
import { type AuthContext, getLocale, respond, v } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { describeRoute } from "hono-openapi";
import { PublicId } from "../contracts";
import { QueryInput, QueryUpdate, QueryRevision, QueryPage, QueryId } from "../saved-queries";
import { savedQueries } from "../service/saved-queries";
import { apiErrorMessage } from "../errors";
const identity = (c: import("hono").Context<AuthContext>) => ({ actor: c.get("actor"), accessSubject: c.get("accessSubject") });
const invalid = (c: import("hono").Context) => ({ code: "INVALID_INPUT", message: apiErrorMessage("INVALID_INPUT", getLocale(c)) });
const docs = (summary: string) => describeRoute({ tags: ["Kit saved queries"], summary });
export const savedQueriesApi = new Hono<AuthContext>()
  .get("/projects/:id/queries", docs("List shared saved queries (Use)"), v("query", QueryPage, invalid), async (c) =>
    respond(c, ok(await savedQueries.list(PublicId.parse(c.req.param("id")), c.req.valid("query").page, identity(c), c.req.valid("query").name))),
  )
  .post("/projects/:id/queries", docs("Create a saved query (Admin)"), v("json", QueryInput, invalid), async (c) =>
    respond(c, ok(await savedQueries.create(PublicId.parse(c.req.param("id")), c.req.valid("json"), identity(c))), 201),
  )
  .get("/projects/:id/queries/:queryId", docs("Read a saved query (Use)"), async (c) =>
    respond(c, ok(await savedQueries.get(PublicId.parse(c.req.param("id")), QueryId.parse(c.req.param("queryId")), identity(c)))),
  )
  .put("/projects/:id/queries/:queryId", docs("Update a query at its exact revision (Admin)"), v("json", QueryUpdate, invalid), async (c) =>
    respond(
      c,
      ok(
        await savedQueries.update(
          PublicId.parse(c.req.param("id")),
          QueryId.parse(c.req.param("queryId")),
          c.req.valid("json"),
          identity(c),
        ),
      ),
    ),
  )
  .delete(
    "/projects/:id/queries/:queryId",
    docs("Delete a query at its exact revision (Admin)"),
    v("json", QueryRevision, invalid),
    async (c) =>
      respond(
        c,
        ok(
          await savedQueries.delete(
            PublicId.parse(c.req.param("id")),
            QueryId.parse(c.req.param("queryId")),
            c.req.valid("json"),
            identity(c),
          ),
        ),
      ),
  );
