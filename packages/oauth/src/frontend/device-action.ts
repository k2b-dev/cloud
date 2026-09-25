import { type AuthContext, expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { get } from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import type { Context } from "hono";
import { z } from "zod";
import { oauth } from "../service/oauth";
import { oauthMessages } from "./messages";

export const DeviceDecisionSchema = z.object({
  request: z.uuid(),
  decision: z.enum(["approve", "deny"]),
});

const blocked = (c: Context<AuthContext>, description: string) =>
  c.redirect(`/oauth/error?error=access_denied&error_description=${encodeURIComponent(description)}`, 303);

/** Apply one approve or deny decision from the confirmation form, then show the result page. */
export const completeDeviceDecision = async (c: Context<AuthContext>, input: z.infer<typeof DeviceDecisionSchema>): Promise<Response> => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  if (c.get("credentialKind") !== "session") return blocked(c, t.deviceSessionRequired);
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

  const decided = await oauth.device.decide({
    id: pending.id,
    client,
    decision: input.decision,
    actor: { userId: user.id, uid: user.uid, provider: user.provider, roles: user.roles },
  });
  if (!decided) return c.redirect("/oauth/device?result=expired", 303);
  return c.redirect(`/oauth/device?result=${input.decision === "approve" ? "approved" : "denied"}`, 303);
};
