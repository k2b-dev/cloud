import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, jsonResponse, respond, v } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { CreateDocumentLinkSchema } from "../contracts";
import { gridsService } from "../service";
import {
  auditRequestContext,
  gateDocument,
  PublicCreateDocumentLinkResponseSchema,
  PublicDocumentLinkListResponseSchema,
  PublicDocumentLinkSchema,
  projectDocumentLinks,
} from "./documents-api-shared";
import { currentActorUserId } from "./permissions";
import { resolvePublicIdParam } from "./route-params";

export const createDocumentLinkRoutes = () =>
  new Hono<AuthContext>()
    .get(
      "/:documentId/links",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "List expiring public links for a generated document",
        responses: {
          200: jsonResponse(PublicDocumentLinkListResponseSchema, "Document links"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      async (c) => {
        const documentId = await resolvePublicIdParam(c, "documentId", "document");
        if (!documentId) return c.json({ message: "Document not found" }, 404);
        const document = await gridsService.document.getDocument(documentId);
        if (!document) return c.json({ message: "Document not found" }, 404);
        const gate = await gateDocument(c, document, "write");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        return c.json({ items: await projectDocumentLinks(await gridsService.document.listDocumentLinks(document.id)) });
      },
    )

    .post(
      "/:documentId/links",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Create an expiring public link for a generated document",
        responses: {
          201: jsonResponse(PublicCreateDocumentLinkResponseSchema, "Created document link"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("json", CreateDocumentLinkSchema),
      async (c) => {
        const documentId = await resolvePublicIdParam(c, "documentId", "document");
        if (!documentId) return c.json({ message: "Document not found" }, 404);
        const document = await gridsService.document.getDocument(documentId);
        if (!document) return c.json({ message: "Document not found" }, 404);
        const gate = await gateDocument(c, document, "write");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const created = await gridsService.document.createDocumentLink({
          document,
          input: c.req.valid("json"),
          actorId: currentActorUserId(c),
          ...auditRequestContext(c),
        });
        if (!created.ok) return c.json({ message: created.error.message }, created.error.status);
        return c.json(
          {
            link: (await projectDocumentLinks([created.data.link]))[0]!,
            url: await gridsService.document.publicDocumentLinkUrl(created.data.token),
          },
          201,
        );
      },
    )

    .post(
      "/links/:linkId/revoke",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Revoke an expiring public document link",
        responses: {
          200: jsonResponse(PublicDocumentLinkSchema, "Revoked document link"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      async (c) => {
        const linkId = await resolvePublicIdParam(c, "linkId", "documentLink");
        if (!linkId) return c.json({ message: "Document link not found" }, 404);
        const link = await gridsService.document.getDocumentLink(linkId);
        if (!link) return c.json({ message: "Document link not found" }, 404);
        const document = await gridsService.document.getDocument(link.documentId);
        if (!document) return c.json({ message: "Document not found" }, 404);
        const gate = await gateDocument(c, document, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));

        const userId = currentActorUserId(c);
        const canRevoke = link.createdBy === userId || gridsService.permission.hasAtLeast(gate.data, "write");
        if (!canRevoke) return c.json({ message: "Only the creator or a document editor can revoke this link." }, 403);

        const revoked = await gridsService.document.revokeDocumentLink({
          linkId: link.id,
          actorId: userId,
          ...auditRequestContext(c),
        });
        if (!revoked.ok) return c.json({ message: revoked.error.message }, revoked.error.status);
        return c.json((await projectDocumentLinks([revoked.data]))[0]!);
      },
    );
