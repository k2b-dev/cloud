import { sql } from "@k2b/cloud";
import { type AuthContext, auth, expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { audit, get } from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import type { Context } from "hono";
import { z } from "zod";
import { oauth } from "../service/oauth";
import { BrowserSignInRequiredError } from "../service/sign-in";
import { type ErrorReason, errorPageHref } from "./error-reasons";
import { oauthMessages } from "./messages";

export const ConsentDecisionSchema = z.object({
  request: z.uuid(),
  decision: z.enum(["approve", "deny"]),
});

/** The error page says the reason in the person's language by its code. */
const refused = (c: Context<AuthContext>, reason: ErrorReason) => c.redirect(errorPageHref(reason));

const actorForAudit = (user: AuthContext["Variables"]["user"]) => ({
  userId: user.id,
  uid: user.uid,
  provider: user.provider,
  roles: user.roles,
});

const redirectWithDecision = (redirectUri: string, state: string | undefined, params: Record<string, string>): string => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (state !== undefined) url.searchParams.set("state", state);
  return url.toString();
};

export const completeConsent = async (c: Context<AuthContext>, decisionInput: z.infer<typeof ConsentDecisionSchema>): Promise<Response> => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const { request: requestId, decision } = decisionInput;
  // A grant would outlive removing the phone, so only the web may decide.
  const browserSignIn = await auth.browserSignIn(c);
  if (!browserSignIn) return refused(c, "web_session_required");
  const sessionToken = c.get("sessionToken");
  const session = sessionToken ? await auth.session.authenticateRequest(c, sessionToken) : null;
  if (!session) return refused(c, "web_session_required");
  const issuer = publicCloudOrigin(await get<string>("app.url"));
  const requestOrigin = c.req.header("origin");
  if (requestOrigin && requestOrigin !== issuer) return refused(c, "origin_invalid");

  const request = await oauth.consent.consume(requestId);
  const user = expectUserBackedActor(c);
  if (!request || request.userId !== user.id) return refused(c, "consent_invalid");

  const client = await oauth.clients.getByClientId({ clientId: request.clientId });
  if (
    !client ||
    (client.registrationKind !== "dynamic" && client.registrationKind !== "first_party") ||
    !oauth.clients.validateRedirectUri(client, request.redirectUri) ||
    !oauth.clients.validateResource(client, request.resource ?? undefined, issuer) ||
    request.scopes.some((scope) => !client.scopes.includes(scope)) ||
    !(await oauth.clients.canAuthorizeUser({ client, userId: user.id, profile: user.profile }))
  ) {
    return refused(c, "consent_expired");
  }

  if (decision === "deny") {
    await audit.record({
      action: client.registrationKind === "dynamic" ? "oauth.dynamic_client.authorize" : "oauth.client.authorize",
      outcome: "denied",
      actor: actorForAudit(user),
      target: { type: "oauth_client", id: client.id, label: client.name },
      reason: "resource_owner_denied",
      metadata: { resource: request.resource, scopes: request.scopes, redirectHost: new URL(request.redirectUri).host },
    });
    return c.redirect(
      redirectWithDecision(request.redirectUri, request.state, {
        error: "access_denied",
        error_description: t.resourceOwnerDenied,
        iss: issuer,
      }),
    );
  }

  let code: string;
  try {
    code = await sql.begin(async (tx) => {
      const createdCode = await oauth.codes.create({
        clientId: client.clientId,
        userId: user.id,
        authEpoch: session.data.authEpoch,
        redirectUri: request.redirectUri,
        scopes: request.scopes,
        resource: request.resource ?? undefined,
        nonce: request.nonce,
        codeChallenge: request.codeChallenge,
        codeChallengeMethod: request.codeChallengeMethod,
        db: tx,
        browserSignIn,
      });
      if (client.registrationKind === "dynamic") await oauth.clients.markDynamicAuthorized({ id: client.id, db: tx });
      await audit.record(
        {
          action: client.registrationKind === "dynamic" ? "oauth.dynamic_client.authorize" : "oauth.client.authorize",
          outcome: "allowed",
          actor: actorForAudit(user),
          target: { type: "oauth_client", id: client.id, label: client.name },
          metadata: { resource: request.resource, scopes: request.scopes, redirectHost: new URL(request.redirectUri).host },
        },
        tx,
      );
      return createdCode;
    });
  } catch (error) {
    if (!(error instanceof BrowserSignInRequiredError)) throw error;
    if (error.code === "FORBIDDEN") return refused(c, "consent_expired");
    const renewedRequest = await oauth.consent.create(request);
    return c.redirect(`/oauth/consent?request=${encodeURIComponent(renewedRequest)}`, 303);
  }
  return c.redirect(redirectWithDecision(request.redirectUri, request.state, { code, iss: issuer }));
};
