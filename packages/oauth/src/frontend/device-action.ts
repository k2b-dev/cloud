import { type AuthContext, auth, expectUserBackedActor } from "@k2b/cloud/server";
import { get } from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import type { Context } from "hono";
import { z } from "zod";
import { oauth } from "../service/oauth";
import { BrowserSignInRequiredError } from "../service/sign-in";
import { type ErrorReason, errorPageHref } from "./error-reasons";

export const DeviceDecisionSchema = z.object({
  request: z.uuid(),
  user_code: z.string().max(64).optional(),
  decision: z.enum(["approve", "deny"]),
});

/** The error page says the reason in the person's language by its code; `client` names the application. */
const refused = (c: Context<AuthContext>, reason: ErrorReason, client?: string) => c.redirect(errorPageHref(reason, client), 303);

/** Apply one approve or deny decision from the confirmation form, then show the result page. */
export const completeDeviceDecision = async (c: Context<AuthContext>, input: z.infer<typeof DeviceDecisionSchema>): Promise<Response> => {
  const browserSignIn = await auth.browserSignIn(c);
  if (!browserSignIn) return refused(c, c.get("credentialKind") === "session" ? "web_session_required" : "device_session_required");
  const sessionToken = c.get("sessionToken");
  const session = sessionToken ? await auth.session.authenticateRequest(c, sessionToken) : null;
  if (!session) return refused(c, "web_session_required");
  const issuer = publicCloudOrigin(await get<string>("app.url"));
  const requestOrigin = c.req.header("origin");
  if (requestOrigin && requestOrigin !== issuer) return refused(c, "origin_invalid");

  const user = expectUserBackedActor(c);
  const confirmation = await oauth.device.consumeConfirmation(input.request);
  if (!confirmation || confirmation.userId !== user.id) return c.redirect("/oauth/device?result=expired", 303);

  const pending = await oauth.device.getPending(confirmation.deviceAuthorizationId);
  const client = pending ? await oauth.clients.getByClientId({ clientId: pending.clientId }) : null;
  if (!pending || !client || !oauth.clients.canUseDeviceGrant(client)) return c.redirect("/oauth/device?result=expired", 303);
  if (!(await oauth.clients.canAuthorizeUser({ client, userId: user.id, profile: user.profile }))) {
    return refused(c, "account_not_allowed", client.clientId);
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
    if (error.code === "FORBIDDEN") return refused(c, "account_not_allowed", client.clientId);
    const userCode = input.user_code ? oauth.device.normalizeUserCode(input.user_code) : null;
    const retry = userCode ? await oauth.device.findPendingByUserCode(userCode) : null;
    if (userCode && retry?.id === pending.id)
      return c.redirect(`/oauth/device?user_code=${encodeURIComponent(oauth.device.formatUserCode(userCode))}`, 303);
    return refused(c, "sign_in_again");
  }
  if (!decided) return c.redirect("/oauth/device?result=expired", 303);
  // the connected page finds what was approved by this decision's request, never by a name in the address
  if (input.decision === "approve")
    return c.redirect(`/oauth/device?${new URLSearchParams({ result: "approved", request: pending.id })}`, 303);
  return c.redirect("/oauth/device?result=denied", 303);
};
