/** @jsxImportSource solid-js */

import { type AuthContext, expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import type { Context } from "hono";
import { ssr } from "../config";
import { oauth } from "../service/oauth";
import { DeviceApproval, type DeviceApprovalView } from "./_components/DeviceApproval";
import { oauthMessages } from "./messages";

const MAX_CODE_INPUT_LENGTH = 64;

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

  const result = c.req.query("result");
  if (result === "approved" || result === "denied" || result === "expired") return { kind: "result", outcome: result };

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

  const request = await oauth.device.createConfirmation({ deviceAuthorizationId: pending.id, userId: user.id });
  return {
    kind: "confirm",
    request,
    code: oauth.device.formatUserCode(userCode),
    client: { name: client.name, clientId: client.clientId },
    scopes: pending.scopes,
  };
};

/** Browser page where a signed-in person approves or denies one RFC 8628 device code. */
export default ssr<AuthContext>(async (c) => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const view = await resolveDeviceView(c);
  return () => (
    <Layout c={c} title={[{ title: t.deviceTitle }]}>
      <DeviceApproval view={view} />
    </Layout>
  );
});
