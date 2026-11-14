import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import automationLogPage from "./[mailboxId]/automations/log/page";
import codePage from "./[mailboxId]/code/page";
import draftComposePage from "./[mailboxId]/compose/[draftId]/page";
import draftSeedComposePage from "./[mailboxId]/compose/local/[seedId]/page";
import draftReadPage from "./[mailboxId]/drafts/[draftId]/page";
import mailboxPage from "./[mailboxId]/page";
import composePage from "./compose/page";
import { mailCalendarCommandHref } from "./mail-calendar-command";
import page from "./page";

export default new Hono<AuthContext>()
  .get("/calendar", auth.requireRole("user", ssr.access), async (c) => {
    const href = mailCalendarCommandHref(new URL(c.req.url));
    return href ? c.redirect(href) : ssr.error(c, 400);
  })
  .get("/compose", auth.requireRole("user", ssr.access), ...composePage)
  .get("/", auth.requireRole("user", ssr.access), ...page)
  .get("/:mailboxId/compose/local/:seedId", auth.requireRole("user", ssr.access), ...draftSeedComposePage)
  .get("/:mailboxId/compose/:draftId", auth.requireRole("user", ssr.access), ...draftComposePage)
  .get("/:mailboxId/drafts/:draftId", auth.requireRole("user", ssr.access), ...draftReadPage)
  .get("/:mailboxId/automations/log", auth.requireRole("user", ssr.access), ...automationLogPage)
  .get("/:mailboxId/code", auth.requireRole("user", ssr.access), ...codePage)
  .get("/:mailboxId", auth.requireRole("user", ssr.access), ...mailboxPage);
