import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { ssr } from "../config";
import agentDetailPage from "./agents/detail.page";
import auditPage from "./audit/page";
import deletedAccountsPage from "./deleted-accounts/page";
import groupDetailPage from "./groups/detail/page";
import groupsPage from "./groups/page";
import groupRelationsPage from "./groups/relations/page";
import notificationDetailPage from "./notifications/detail.page";
import notificationsPage from "./notifications/page";
import landingPage from "./page";
import remindersPage from "./reminders/page";
import requestsPage from "./requests/page";
import serviceAccountsPage from "./service-accounts/page";
import userDetailPage from "./users/detail/page";
import usersNewPage from "./users/new/page";
import usersPage from "./users/page";
import { legacyAgentsHref, legacyDuplicateEmailsHref } from "./users/query";

/** Permanent move of the API key list, with any sub-path and the query kept. */
const movedToApiKeys = (c: Context<AuthContext>) => {
  const url = new URL(c.req.url);
  const rest = url.pathname.slice(url.pathname.indexOf("/service-accounts") + "/service-accounts".length);
  return c.redirect(`/app/accounts/api-keys${rest}${url.search}`, 301);
};

/** The account list replaced the agent list and the duplicate address page: their addresses open its views, params kept. */
const movedToAccountList = (to: (params: URLSearchParams) => string) => (c: Context<AuthContext>) =>
  c.redirect(to(new URL(c.req.url).searchParams), 301);

export default new Hono<AuthContext>()
  .use("/", middleware.noTransform())
  .use("/groups/:id", middleware.noTransform())
  .use("/groups/:id/*", middleware.noTransform())
  .use("/agents", middleware.noTransform())
  .use("/agents/*", middleware.noTransform())
  .use("/api-keys", middleware.noTransform())
  .use("/api-keys/*", middleware.noTransform())
  .use("/users", middleware.noTransform())
  .use("/users/*", middleware.noTransform())
  .use("/duplicate-emails", middleware.noTransform())
  .use("/duplicate-emails/*", middleware.noTransform())
  .use("/deleted-accounts", middleware.noTransform())
  .use("/deleted-accounts/*", middleware.noTransform())
  .use("/reminders", middleware.noTransform())
  .use("/reminders/*", middleware.noTransform())
  .use("/audit", middleware.noTransform())
  .use("/audit/*", middleware.noTransform())
  .use("/requests", middleware.noTransform())
  .use("/requests/*", middleware.noTransform())
  .use("/notifications/*", middleware.noTransform())
  .get("/", auth.requireRole("user", ssr.access), ...landingPage)
  .get("/duplicate-emails", movedToAccountList(legacyDuplicateEmailsHref))
  .get("/users", auth.requireRole("admin", ssr.access), ...usersPage)
  .get("/users/new", auth.requireRole("admin", ssr.access), ...usersNewPage)
  .get("/users/:id", auth.requireRole("admin", ssr.access), ...userDetailPage)
  .get("/requests", auth.requireRole("admin", ssr.access), ...requestsPage)
  .get("/audit", auth.requireRole("admin", ssr.access), ...auditPage)
  .get("/api-keys", auth.requireRole("admin", ssr.access), ...serviceAccountsPage)
  // The API key list moved from /service-accounts; old bookmarks and links keep working.
  .get("/service-accounts", movedToApiKeys)
  .get("/service-accounts/*", movedToApiKeys)
  .get("/agents", movedToAccountList(legacyAgentsHref))
  .get("/agents/:id", auth.requireRole("admin", ssr.access), ...agentDetailPage)
  .get("/notifications", auth.requireRole("admin", ssr.access), ...notificationsPage)
  .get("/notifications/:id", auth.requireRole("admin", ssr.access), ...notificationDetailPage)
  .get("/deleted-accounts", auth.requireRole("admin", ssr.access), ...deletedAccountsPage)
  .get("/reminders", auth.requireRole("admin", ssr.access), ...remindersPage)
  .get("/groups", auth.requireRole("user", ssr.access), ...groupsPage)
  .get("/groups/relations", auth.requireRole("admin", ssr.access), ...groupRelationsPage)
  .get("/groups/:id", auth.requireRole("user", ssr.access), ...groupDetailPage);
