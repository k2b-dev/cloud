import { ssr } from "../config";
import { type AuthContext, auth } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import automationActivityPage from "./[mailboxId]/automations/activity/page";
import incomingAutomationsPage from "./[mailboxId]/automations/incoming/page";
import automationsPage from "./[mailboxId]/automations/page";
import automaticRepliesPage from "./[mailboxId]/automations/replies/page";
import workflowsPage from "./[mailboxId]/automations/workflows/page";
import draftComposePage from "./[mailboxId]/compose/[draftId]/page";
import draftSeedComposePage from "./[mailboxId]/compose/local/[seedId]/page";
import mailboxPage from "./[mailboxId]/page";
import composePage from "./compose/page";
import page from "./page";

export default new Hono<AuthContext>()
  .get("/compose", auth.requireRole("user", ssr.access), ...composePage)
  .get("/", auth.requireRole("user", ssr.access), ...page)
  .get("/:mailboxId/compose/local/:seedId", auth.requireRole("user", ssr.access), ...draftSeedComposePage)
  .get("/:mailboxId/compose/:draftId", auth.requireRole("user", ssr.access), ...draftComposePage)
  .get("/:mailboxId/automations", auth.requireRole("user", ssr.access), ...automationsPage)
  .get("/:mailboxId/automations/replies", auth.requireRole("user", ssr.access), ...automaticRepliesPage)
  .get("/:mailboxId/automations/incoming", auth.requireRole("user", ssr.access), ...incomingAutomationsPage)
  .get("/:mailboxId/automations/activity", auth.requireRole("user", ssr.access), ...automationActivityPage)
  .get("/:mailboxId/automations/workflows", auth.requireRole("user", ssr.access), ...workflowsPage)
  .get("/:mailboxId", auth.requireRole("user", ssr.access), ...mailboxPage);
