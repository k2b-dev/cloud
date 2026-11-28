import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import codePage from "./[mailboxId]/code/page";
import draftComposePage from "./[mailboxId]/compose/[draftId]/page";
import draftSeedComposePage from "./[mailboxId]/compose/local/[seedId]/page";
import draftReadPage from "./[mailboxId]/drafts/[draftId]/page";
import mailboxPage from "./[mailboxId]/page";
import composePage from "./compose/page";
import { mailCalendarCommandHref } from "./mail-calendar-command";
import { mailCodeCatchUpRedirect } from "./mail-code-catch-up-address";
import { mailCodeHistoryRedirect } from "./mail-code-history-address";
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
  // The retired rules' history is a step of the mailbox's Code page: the old address keeps its day, entry and run.
  .get("/:mailboxId/automations/log", auth.requireRole("user", ssr.access), (c) =>
    c.redirect(mailCodeHistoryRedirect(new URL(c.req.url)), 301),
  )
  // "Process existing mail" is a step of the mailbox's Code page: the old address keeps its place in the flow.
  .get("/:mailboxId/code/catch-up", auth.requireRole("user", ssr.access), (c) =>
    c.redirect(mailCodeCatchUpRedirect(new URL(c.req.url)), 301),
  )
  .get("/:mailboxId/code", auth.requireRole("user", ssr.access), ...codePage)
  .get("/:mailboxId", auth.requireRole("user", ssr.access), ...mailboxPage);
