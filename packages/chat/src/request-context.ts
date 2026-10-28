import type { CapabilityCaller } from "@k2b/cloud/capabilities/server";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import type { Context } from "hono";
import type { ChatContext } from "./service/access";

export type ChatRequestContext = ChatContext & { caller: CapabilityCaller; credentialPrincipal: string };
/** API and SSR use the same caller and credential partition as Cloud's LiveViewer. */
export const chatRequestContext = <Env extends AuthContext>(c: Context<Env>): ChatRequestContext => {
  const accessSubject = c.get("accessSubject");
  const principal = accessSubject.type === "user" ? `user:${accessSubject.userId}` : `service_account:${accessSubject.serviceAccountId}`;
  const scopes = c.get("credentialScopes") ?? [];
  const suffix =
    c.get("credentialKind") === "session"
      ? c.get("sessionKind") === "app"
        ? ":app"
        : ""
      : `:scopes=${[...new Set(scopes)].sort().join(",")}`;
  return {
    actor: c.get("actor"),
    accessSubject,
    locale: getLocale(c),
    credentialScopes: c.get("credentialScopes"),
    requestId: c.req.header("x-request-id"),
    credentialPrincipal: principal + suffix,
    caller: {
      cookie: c.req.header("cookie"),
      authorization: c.req.header("authorization"),
      locale: getLocale(c),
      signal: c.req.raw.signal,
      requestId: c.req.header("x-request-id"),
    },
  };
};
