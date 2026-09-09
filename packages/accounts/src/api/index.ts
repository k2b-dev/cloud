import { getLocale, rateLimit } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import accountRequestsRoutes from "./account-requests";
import actionNoticeRoutes from "./action-notice";
import auditRoutes from "./audit";
import groupsRoutes from "./groups";
import { accountsApiErrorMessage } from "./messages";
import notificationsRoutes from "./notifications";
import serviceAccountsRoutes from "./service-accounts";
import usersRoutes from "./users";
import widgetRoutes from "./widgets";

const localizeApiError = async (c: Context, next: () => Promise<void>) => {
  await next();
  if (c.res.status < 400 || !c.res.headers.get("content-type")?.includes("application/json")) return;
  const body: unknown = await c.res
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== "object" || !("message" in body) || typeof body.message !== "string") return;
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  c.res = new Response(JSON.stringify({ ...body, message: accountsApiErrorMessage(c.res.status, getLocale(c), body.message) }), {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
};

/** Accounts API — users, groups, account requests, and dashboard widget. */
//
// Mounted at `/api/accounts`, so sub-routes become:
//   /api/accounts/widget/*  — dashboard widget endpoints (own auth)
//   /api/accounts/users/*, /groups/*, /account-requests/*  — admin api
const app = new Hono()
  .use(localizeApiError)
  .route("/widget", widgetRoutes)
  .use(rateLimit())
  .route("/action-notice", actionNoticeRoutes)
  .route("/users", usersRoutes)
  .route("/groups", groupsRoutes)
  .route("/account-requests", accountRequestsRoutes)
  .route("/audit", auditRoutes)
  .route("/service-accounts", serviceAccountsRoutes)
  .route("/notifications", notificationsRoutes);

export default app;
export type ApiType = typeof app;
