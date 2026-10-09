/** @jsxImportSource solid-js */

import { type AuthContext, expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import type { Context, Env } from "hono";
import { ssr } from "../config";
import { oauth } from "../service/oauth";
import { AuthorizationPage } from "./_components/AuthorizationPage";
import { ConsentDecision } from "./_components/ConsentDecision";
import { oauthMessages } from "./messages";

function localError<E extends Env>(c: Context<E>, description: string) {
  return c.redirect(`/oauth/error?error=invalid_request&error_description=${encodeURIComponent(description)}`);
}

/** Browser confirmation for one validated dynamic-client authorization request. */
export default ssr<AuthContext>(async (c) => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const requestId = c.req.query("request");
  if (!requestId) return localError(c, t.consentMissing);
  const request = await oauth.consent.get(requestId);
  const user = expectUserBackedActor(c);
  if (!request || request.userId !== user.id) return localError(c, t.consentInvalid);
  const client = await oauth.clients.getByClientId({ clientId: request.clientId });
  if (!client || client.registrationKind !== "dynamic") return localError(c, t.clientUnavailable);

  return () => (
    <AuthorizationPage c={c} title={t.authorizeApplication}>
      <ConsentDecision
        view={{
          request: requestId,
          client: { name: client.name, clientId: client.clientId },
          resource: request.resource,
          redirectHost: new URL(request.redirectUri).host,
          scopes: request.scopes,
        }}
      />
    </AuthorizationPage>
  );
});
