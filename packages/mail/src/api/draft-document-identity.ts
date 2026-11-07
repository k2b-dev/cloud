import { getLocale, type RequestActor } from "@k2b/cloud/server";
import { i18n } from "@k2b/stdlib";
import type { Context, MiddlewareHandler } from "hono";
import { DRAFT_DOCUMENT_EXPECTED_USER_QUERY } from "../draft-document-contracts";
import type { MailApiContext } from "./public-resource-boundary";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { mismatch: "The signed-in account changed. Reopen the draft with the original account." },
    de: { mismatch: "Das angemeldete Konto hat sich geändert. Öffne den Entwurf mit dem ursprünglichen Konto erneut." },
  },
});

/** Compare the request's authenticated actor, never a separate whoami or the access subject. */
export const draftDocumentAccountMatches = (
  actor: RequestActor | undefined,
  session: boolean,
  expected: readonly string[] | undefined,
): boolean => {
  if (!expected) return !session;
  return expected.length === 1 && Boolean(expected[0]) && actor?.kind === "user" && actor.user.id === expected[0];
};

/** Also called by the socket handler when mounted independently. */
export const draftDocumentAccountRejection = (c: Context<MailApiContext>): Response | null => {
  // A successful authorization from another cookie must never be reused from an HTTP cache.
  c.header("Cache-Control", "no-store");
  if (
    !draftDocumentAccountMatches(c.get("actor"), c.get("credentialKind") === "session", c.req.queries(DRAFT_DOCUMENT_EXPECTED_USER_QUERY))
  ) {
    return c.json({ code: "DRAFT_ACCOUNT_MISMATCH", message: messages.resolve([getLocale(c)]).t.mismatch }, 403);
  }
  return null;
};

/** Mount before document body readers/validators and all document service calls. */
export const requireDraftDocumentAccount: MiddlewareHandler<MailApiContext> = async (c, next) => {
  const rejection = draftDocumentAccountRejection(c);
  if (rejection) return rejection;
  await next();
};
