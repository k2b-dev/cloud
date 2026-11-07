import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Button, ButtonLink } from "@k2b/ui";
import { ssr } from "../config";
import { AuthorizationPage } from "./_components/AuthorizationPage";
import { DecisionHeader } from "./_components/AuthorizationParts";
import { oauthMessages } from "./messages";

/** A relying party may navigate here, but only the person's POST ends the session. */
export default ssr<AuthContext>(async (c) => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const query = new URLSearchParams();
  for (const key of ["client_id", "post_logout_redirect_uri"]) {
    const value = c.req.query(key);
    if (value) query.set(key, value);
  }
  const action = `/oauth/logout${query.size ? `?${query}` : ""}`;
  return () => (
    <AuthorizationPage c={c} title={t.signOut}>
      <DecisionHeader title={t.signOut}>{t.signOutHint}</DecisionHeader>
      <form method="post" action={action} class="mt-6 grid grid-cols-2 gap-3">
        <ButtonLink href="/" variant="secondary" size="lg" class="w-full">
          {t.cancelSignOut}
        </ButtonLink>
        <Button type="submit" size="lg" class="w-full">
          {t.signOut}
        </Button>
      </form>
    </AuthorizationPage>
  );
});
