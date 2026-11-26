import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Bar, Button, Text } from "@k2b/ui/v2";
import { ssr } from "../config";
import { AuthorizationPage } from "./_components/AuthorizationPage";
import { oauthMessages } from "./messages";

/** The `id` of the sign-out form; its button stands in the bar and sends it by this name. */
const SIGN_OUT_FORM = "oauth-sign-out";

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
      <Text>{t.signOutHint}</Text>
      <form id={SIGN_OUT_FORM} method="post" action={action} hidden />
      <Bar
        end={
          <>
            <Button href="/">{t.cancelSignOut}</Button>
            <Button variant="primary" icon="logout" type="submit" form={SIGN_OUT_FORM}>
              {t.signOut}
            </Button>
          </>
        }
      />
    </AuthorizationPage>
  );
});
