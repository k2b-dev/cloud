/** @jsxImportSource solid-js */

import { type AuthContext, auth, expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { get } from "@k2b/cloud/services";
import { createLoginRedirectUrl, publicCloudOrigin } from "@k2b/cloud/shared";
import type { Context, Env } from "hono";
import { ssr } from "../config";
import { oauth } from "../service/oauth";
import { isConfirmedBrowserSignIn } from "../service/sign-in";
import { AuthorizationPage, signedInName } from "./_components/AuthorizationPage";
import { ConsentDecision } from "./_components/ConsentDecision";
import { type ErrorReason, errorPageHref } from "./error-reasons";
import { oauthMessages } from "./messages";

/** The error page says the reason in the person's language by its code. */
function refused<E extends Env>(c: Context<E>, reason: ErrorReason) {
  return c.redirect(errorPageHref(reason));
}

/** Browser confirmation for one validated client authorization request. */
export default ssr<AuthContext>(async (c) => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const requestId = c.req.query("request");
  if (!requestId) return refused(c, "consent_missing");
  const request = await oauth.consent.get(requestId);
  const user = expectUserBackedActor(c);
  if (!request || request.userId !== user.id) return refused(c, "consent_invalid");
  const client = await oauth.clients.getByClientId({ clientId: request.clientId });
  if (!client || (client.registrationKind !== "dynamic" && client.registrationKind !== "first_party"))
    return refused(c, "client_unavailable");

  const issuer = publicCloudOrigin(await get<string>("app.url"));
  const reauthenticateHref =
    request.scopes.includes("offline_access") && !(await isConfirmedBrowserSignIn(await auth.browserSignIn(c)))
      ? createLoginRedirectUrl(`${issuer}/oauth/consent?request=${encodeURIComponent(requestId)}&reauthenticate=1`)
      : null;

  return () => (
    <AuthorizationPage c={c} person={signedInName(c.get("actor"))} title={t.authorizeApplication} heading={t.authorizeApplication}>
      <ConsentDecision
        view={{
          request: requestId,
          client: { name: client.name, clientId: client.clientId },
          firstParty: client.registrationKind === "first_party",
          reauthenticateHref,
          resource: request.resource,
          redirectHost: new URL(request.redirectUri).host,
          scopes: request.scopes,
        }}
      />
    </AuthorizationPage>
  );
});
