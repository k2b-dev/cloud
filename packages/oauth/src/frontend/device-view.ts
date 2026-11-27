import { type AuthContext, auth, expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { get } from "@k2b/cloud/services";
import { createLoginRedirectUrl, publicCloudOrigin } from "@k2b/cloud/shared";
import type { Context } from "hono";
import { oauth } from "../service/oauth";
import { isConfirmedBrowserSignIn } from "../service/sign-in";
import type { DeviceApprovalView } from "./_components/DeviceApproval";
import { mayBeNamed } from "./error-reasons";
import { oauthMessages } from "./messages";

const MAX_CODE_INPUT_LENGTH = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same client address the platform rate limiter keys on. */
const deviceClientIp = (c: Context): string =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown";

/** Resolve which state of the device approval page this request sees. */
export const resolveDeviceView = async <E extends AuthContext>(c: Context<E>): Promise<DeviceApprovalView> => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const user = expectUserBackedActor(c);
  if (c.get("credentialKind") !== "session") {
    c.status(403);
    return { kind: "result", outcome: "blocked", message: t.deviceSessionRequired };
  }
  if (c.get("sessionKind") === "app") {
    c.status(403);
    return { kind: "result", outcome: "blocked", message: t.webSessionRequired };
  }

  const result = c.req.query("result");
  if (result === "approved") {
    // what was connected, and to whom: only a request this person approved names its application, and only one an
    // administrator registered for devices; anything else says the generic sentence
    const request = c.req.query("request");
    const clientId = request && UUID.test(request) ? await oauth.device.approvedClientId({ id: request, userId: user.id }) : null;
    const client = clientId ? await oauth.clients.getByClientId({ clientId }) : null;
    if (!client || !mayBeNamed(client)) return { kind: "result", outcome: result };
    return {
      kind: "result",
      outcome: result,
      message: t.deviceApprovedFor({ app: client.name }),
    };
  }
  if (result === "denied" || result === "expired") return { kind: "result", outcome: result };

  const typed = c.req.query("user_code");
  if (typed === undefined) return { kind: "entry" };

  const subjects = { ip: deviceClientIp(c), userId: user.id };
  if (await oauth.device.isEntryBlocked(subjects)) {
    c.status(429);
    return { kind: "entry", code: typed.slice(0, MAX_CODE_INPUT_LENGTH), error: t.deviceTooManyAttempts };
  }

  const userCode = oauth.device.normalizeUserCode(typed.slice(0, MAX_CODE_INPUT_LENGTH));
  const pending = userCode ? await oauth.device.findPendingByUserCode(userCode) : null;
  if (!userCode || !pending) {
    await oauth.device.recordFailedEntry(subjects);
    c.status(400);
    return { kind: "entry", code: typed.slice(0, MAX_CODE_INPUT_LENGTH), error: t.deviceCodeInvalid };
  }

  const client = await oauth.clients.getByClientId({ clientId: pending.clientId });
  if (!client || !oauth.clients.canUseDeviceGrant(client)) return { kind: "result", outcome: "expired" };
  if (!(await oauth.clients.canAuthorizeUser({ client, userId: user.id, profile: user.profile }))) {
    c.status(403);
    return { kind: "result", outcome: "blocked", message: t.deviceNoAccess };
  }

  const issuer = publicCloudOrigin(await get<string>("app.url"));
  const reauthenticateHref =
    pending.scopes.includes("offline_access") && !(await isConfirmedBrowserSignIn(await auth.browserSignIn(c)))
      ? createLoginRedirectUrl(
          `${issuer}/oauth/device?user_code=${encodeURIComponent(oauth.device.formatUserCode(userCode))}&reauthenticate=1`,
        )
      : null;
  const request = await oauth.device.createConfirmation({ deviceAuthorizationId: pending.id, userId: user.id });
  return {
    kind: "confirm",
    request,
    code: oauth.device.formatUserCode(userCode),
    client: { name: client.name, clientId: client.clientId, kind: client.registrationKind },
    scopes: pending.scopes,
    reauthenticateHref,
  };
};
