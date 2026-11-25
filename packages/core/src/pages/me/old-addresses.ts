import type { Context } from "hono";
import { type ActivityKind, activityHref } from "./activity-query";

/**
 * The account pages before the account became one record with an activity list (v2). Every old address stays valid:
 * it answers with a redirect to its new place and keeps every parameter, such as the way back after confirming the
 * identity (`create=api-key`, `pair=1`) or an app's filter of the approvals (`app=`).
 */
const search = (c: Context) => new URL(c.req.url).search;

/** `/me/developer` (API keys) and `/me/app` (the phones of the mobile app) are part of "Security & devices" now. */
export const toSecurity = (c: Context) => c.redirect(`/me/security${search(c)}`, 302);

/** `/me/approvals`, `/me/notifications/history` and `/me/security/activity` are kinds of the one activity list now. */
export const toActivity = (kind: ActivityKind) => (c: Context) => c.redirect(activityHref(kind, new URL(c.req.url).searchParams), 302);

/** Each old address with its redirect, as the pages router registers them. */
export const oldAccountAddresses = [
  ["/me/security/activity", toActivity("sign-ins")],
  ["/me/notifications/history", toActivity("deliveries")],
  ["/me/approvals", toActivity("open")],
  ["/me/developer", toSecurity],
  ["/me/app", toSecurity],
] as const;
