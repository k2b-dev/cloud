import { type AuthContext, auth } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import auditPage from "./audit/page";
import deletedAccountsPage from "./deleted-accounts/page";
import duplicateEmailsPage from "./duplicate-emails/page";
import groupDetailPage from "./groups/detail/page";
import groupsPage from "./groups/page";
import notificationDetailPage from "./notifications/detail.page";
import notificationsPage from "./notifications/page";
import landingPage from "./page";
import remindersPage from "./reminders/page";
import requestsPage from "./requests/page";
import serviceAccountsPage from "./service-accounts/page";
import userDetailPage from "./users/detail/page";
import usersNewPage from "./users/new/page";
import usersPage from "./users/page";

export default new Hono<AuthContext>()
  .get("/", auth.requireRole("user", ssr.access), ...landingPage)
  .get("/duplicate-emails", auth.requireRole("admin", ssr.access), ...duplicateEmailsPage)
  .get("/users", auth.requireRole("admin", ssr.access), ...usersPage)
  .get("/users/new", auth.requireRole("admin", ssr.access), ...usersNewPage)
  .get("/users/:id", auth.requireRole("admin", ssr.access), ...userDetailPage)
  .get("/requests", auth.requireRole("admin", ssr.access), ...requestsPage)
  .get("/audit", auth.requireRole("admin", ssr.access), ...auditPage)
  .get("/service-accounts", auth.requireRole("admin", ssr.access), ...serviceAccountsPage)
  .get("/notifications", auth.requireRole("admin", ssr.access), ...notificationsPage)
  .get("/notifications/:id", auth.requireRole("admin", ssr.access), ...notificationDetailPage)
  .get("/deleted-accounts", auth.requireRole("admin", ssr.access), ...deletedAccountsPage)
  .get("/reminders", auth.requireRole("admin", ssr.access), ...remindersPage)
  .get("/groups", auth.requireRole("user", ssr.access), ...groupsPage)
  .get("/groups/:id", auth.requireRole("user", ssr.access), ...groupDetailPage);
