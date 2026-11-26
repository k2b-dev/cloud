import { ButtonLink, NoticeCard, useLocale } from "@k2b/ui";
import { signInAgainHref } from "../sign-out-others";
import { authMessages } from "./messages";

/** Shown when a password change succeeded but a sign-out everywhere ended its new sign-in before it was issued. */
export function PasswordChangedSignInAgain(props: { redirectTo?: string }) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  return (
    <NoticeCard tone="warning" role="alert" title={t().passwordChangedSignInAgain}>
      <div class="flex flex-wrap gap-2">
        <ButtonLink size="sm" navigation="document" href={signInAgainHref(props.redirectTo)}>
          <i class="ti ti-login-2" />
          <span>{t().signIn}</span>
        </ButtonLink>
      </div>
    </NoticeCard>
  );
}
