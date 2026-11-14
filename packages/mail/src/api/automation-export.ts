import { auth, respond, v } from "@k2b/cloud/server";
import { Hono } from "hono";
import { mailAutomationExportPageSchema, mailAutomationExportQuerySchema } from "../automation-export-contracts";
import { exportMailAutomation } from "../service/automation-export";
import { historyOperation } from "./history-openapi";
import { internalMailboxId, type MailApiContext, mailboxParamSchema, resolveMailboxParam } from "./public-resource-boundary";

// The service already returns public IDs. Do not rewrite IDs inside source, bindings or guided definitions.
export default new Hono<MailApiContext>()
  .get(
    "/mailboxes/:mailboxId/automation-export",
    auth.requireOAuthScope("read", "admin"),
    resolveMailboxParam,
    historyOperation("Export Mail automation definitions", mailAutomationExportPageSchema, "Versioned definition export", [404]),
    v("param", mailboxParamSchema),
    v("query", mailAutomationExportQuerySchema),
    async (c) => {
      c.header("Cache-Control", "no-store");
      return respond(
        c,
        await exportMailAutomation(
          { actor: c.get("actor"), accessSubject: c.get("accessSubject") },
          { mailboxId: internalMailboxId(c), ...c.req.valid("query") },
        ),
      );
    },
  )
  .get(
    "/admin/automation-export",
    auth.requireRole("admin"),
    auth.requireOAuthScope("read", "admin"),
    historyOperation("Export installation Mail automation definitions", mailAutomationExportPageSchema, "Versioned definition export"),
    v("query", mailAutomationExportQuerySchema),
    async (c) => {
      c.header("Cache-Control", "no-store");
      return respond(c, await exportMailAutomation({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, c.req.valid("query")));
    },
  );
