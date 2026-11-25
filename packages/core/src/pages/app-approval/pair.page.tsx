import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { accounts, appApproval, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { z } from "zod";
import { ssr } from "../../config";
import { accountUserView } from "../me/account-view";
import { pwaAvailable } from "../me/app-availability";
import { accountMessages } from "../me/messages";
import { approvalAvailability } from "./availability";
import { appApprovalMessages } from "./messages";
import PairScreen from "./PairScreen.island";

export default ssr<AuthContext>(async (c) => {
  const actor = c.get("user");
  const id = c.req.query("userId") ?? actor.id;
  if (!z.string().uuid().safeParse(id).success) return ssr.error(c, 404);
  if (id !== actor.id && !actor.roles.includes("admin")) return ssr.error(c, 403);
  const config = await appApproval.config(false).catch(() => null);
  if (id !== actor.id && !config?.adminPairing) return ssr.error(c, 403);
  const user = id === actor.id ? actor : await accounts.users.get({ id });
  if (!user) return ssr.error(c, 404);
  const policy = await readAccountCategoryPolicy();
  const locale = getLocale(c);
  const { t } = appApprovalMessages.resolve([locale]);
  c.header("Referrer-Policy", "no-referrer");
  const returnTo = id === actor.id ? "/me/security" : `/app/accounts/users/${id}`;
  // Returning from identity confirmation continues after the install step.
  const continuing = c.req.query("pairDevice") === id;
  return () => (
    // The pairing dialog's close returns to `returnTo`, so the shell draws no way up above it.
    <Layout c={c} fullWidth ui="v2" title={t.pair}>
      <PairScreen
        self={
          id === actor.id
            ? { user: accountUserView(actor, policy.login.label, accountMessages.resolve([locale]).t), appTab: pwaAvailable(c) }
            : null
        }
        userId={id}
        actorId={actor.id}
        name={`${user.displayName || user.uid} (${user.uid})`}
        pairing={config?.enabled && config.appOrigin ? { appOrigin: config.appOrigin, install: !continuing } : null}
        availability={approvalAvailability(config)}
        admin={actor.roles.includes("admin")}
        returnTo={returnTo}
      />
    </Layout>
  );
});
