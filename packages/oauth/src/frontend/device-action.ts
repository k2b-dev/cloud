import { type AuthContext, auth, expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { get } from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import type { Context } from "hono";
import { z } from "zod";
import { oauth } from "../service/oauth";
import { BrowserSignInRequiredError } from "../service/sign-in";
import { oauthMessages } from "./messages";

export const DeviceDecisionSchema = z.object({
  request: z.uuid(),
  user_code: z.string().max(64).optional(),
  decision: z.enum(["approve", "deny"]),
});

const blocked = (c: Context<AuthContext>, description: string) =>
  c.redirect(`/oauth/error?error=access_denied&error_description=${encodeURIComponent(description)}`, 303);

/** Apply one approve or deny decision from the confirmation form, then show the result page. */
export const completeDeviceDecision = async (c: Context<AuthContext>, input: z.infer<typeof DeviceDecisionSchema>): Promise<Response> => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const browserSignIn = await auth.browserSignIn(c);
  if (!browserSignIn) return blocked(c, c.get("credentialKind") === "session" ? t.webSessionRequired : t.deviceSessionRequired);
  const sessionToken = c.get("sessionToken");
  const session = sessionToken ? await auth.session.authenticateRequest(c, sessionToken) : null;
  if (!session) return blocked(c, t.webSessionRequired);
  const issuer = publicCloudOrigin(await get<string>("app.url"));
  const requestOrigin = c.req.header("origin");
  if (requestOrigin && requestOrigin !== issuer) return blocked(c, t.consentOriginInvalid);

  const user = expectUserBackedActor(c);
  const confirmation = await oauth.device.consumeConfirmation(input.request);
  if (!confirmation || confirmation.userId !== user.id) return c.redirect("/oauth/device?result=expired", 303);

  const pending = await oauth.device.getPending(confirmation.deviceAuthorizationId);
  const client = pending ? await oauth.clients.getByClientId({ clientId: pending.clientId }) : null;
  if (!pending || !client || !oauth.clients.canUseDeviceGrant(client)) return c.redirect("/oauth/device?result=expired", 303);
  if (!(await oauth.clients.canAuthorizeUser({ client, userId: user.id, profile: user.profile }))) {
    return blocked(c, t.deviceNoAccess);
  }

  let decided: boolean;
  try {
    decided = await oauth.device.decide({
      browserSignIn,
      id: pending.id,
      client,
      decision: input.decision,
      authEpoch: session.data.authEpoch,
      actor: { userId: user.id, uid: user.uid, provider: user.provider, roles: user.roles },
    });
  } catch (error) {
    if (!(error instanceof BrowserSignInRequiredError)) throw error;
    if (error.code === "FORBIDDEN") return blocked(c, t.deviceNoAccess);
    const userCode = input.user_code ? oauth.device.normalizeUserCode(input.user_code) : null;
    const retry = userCode ? await oauth.device.findPendingByUserCode(userCode) : null;
    if (userCode && retry?.id === pending.id)
      return c.redirect(`/oauth/device?user_code=${encodeURIComponent(oauth.device.formatUserCode(userCode))}`, 303);
    return blocked(c, t.deviceSignInAgain);
  }
  if (!decided) return c.redirect("/oauth/device?result=expired", 303);
  return c.redirect(`/oauth/device?result=${input.decision === "approve" ? "approved" : "denied"}`, 303);
};
