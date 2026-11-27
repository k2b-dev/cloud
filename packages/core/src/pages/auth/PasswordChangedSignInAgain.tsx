import { useLocale } from "@k2b/ui";
import { Notice } from "@k2b/ui/v2";
import { signInAgainHref } from "../sign-out-others";
import { authMessages } from "./messages";

/** Shown when a password change succeeded but a sign-out everywhere ended its new sign-in before it was issued. */
export function PasswordChangedSignInAgain(props: { redirectTo?: string }) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  return (
    <Notice tone="warn" actions={[{ label: t().signIn, icon: "login-2", href: signInAgainHref(props.redirectTo) }]}>
      <span role="alert">{t().passwordChangedSignInAgain}</span>
    </Notice>
  );
}
