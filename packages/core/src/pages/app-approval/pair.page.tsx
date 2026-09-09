import { ButtonLink } from "@k2b/ui";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { accounts, appApproval, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { z } from "zod";
import { ssr } from "../../config";
import AccountHub from "../me/AccountHub";
import { appApprovalMessages } from "./messages";
import Pairing from "./Pairing.island";
import ApprovalStatus from "./ApprovalStatus";
import { approvalAvailability } from "./availability";

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
  const { t } = appApprovalMessages.resolve([getLocale(c)]);
  c.header("Referrer-Policy", "no-referrer");
  const returnTo = id === actor.id ? "/me/security" : `/app/accounts/users/${id}`;
  return () => {
    const content = () =>
      config?.enabled && config.appOrigin ? (
        <Pairing
          userId={id}
          actorId={actor.id}
          name={`${user.displayName || user.uid} (${user.uid})`}
          appOrigin={config.appOrigin}
          returnTo={returnTo}
        />
      ) : (
        <div class="flex flex-col items-start gap-3">
          <ApprovalStatus
            state={approvalAvailability(config)}
            admin={actor.roles.includes("admin")}
            settingsLink={actor.roles.includes("admin")}
          />
          <ButtonLink href={returnTo} variant="secondary">
            {t.back}
          </ButtonLink>
        </div>
      );
    return (
      <Layout c={c} title={[{ title: id === actor.id ? t.title : user.displayName || user.uid, href: returnTo }, { title: t.pair }]}>
        {id === actor.id ? (
          <AccountHub user={actor} active="security" loginLabel={policy.login.label}>
            {content()}
          </AccountHub>
        ) : (
          content()
        )}
      </Layout>
    );
  };
});
