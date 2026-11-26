/** @jsxImportSource solid-js */

import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { ssr } from "../config";
import { AuthorizationPage, signedInName } from "./_components/AuthorizationPage";
import { DeviceApproval, deviceResultTitle } from "./_components/DeviceApproval";
import { resolveDeviceView } from "./device-view";
import { oauthMessages } from "./messages";

/** Browser page where a signed-in person approves or denies one RFC 8628 device code. */
export default ssr<AuthContext>(async (c) => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const view = await resolveDeviceView(c);
  // The tab names the task until the request has an answer, then the answer.
  const title = view.kind === "result" ? deviceResultTitle(view.outcome, t) : t.deviceTitle;
  return () => (
    // a confirmation's heading is its question, the one heading of the page
    <AuthorizationPage
      c={c}
      person={signedInName(c.get("actor"))}
      title={title}
      heading={view.kind === "confirm" ? t.deviceConfirmTitle : undefined}
    >
      <DeviceApproval view={view} />
    </AuthorizationPage>
  );
});
