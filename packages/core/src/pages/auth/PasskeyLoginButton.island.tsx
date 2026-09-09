import { cookies } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { NoticeCard, Button, useLocale } from "@k2b/ui";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { apiClient } from "@valentinkolb/cloud/clients/core";
import { authMessages } from "./messages";
import { afterSignInHref } from "./login-redirect";

export default function PasskeyLoginButton(props: { redirectTo?: string }) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  const mutation = mutations.create({
    mutation: async () => {
      if (!browserSupportsWebAuthn()) throw new Error(t().passkeysUnsupported);

      const optionsRes = await apiClient.auth.passkeys.authentication.start.$post();
      const options = await optionsRes.json();
      if (!optionsRes.ok) throw new Error((options as { message?: string }).message ?? t().passkeyStartFailed);

      const response = await startAuthentication({
        optionsJSON: options as never,
      });
      const verifyRes = await apiClient.auth.passkeys.authentication.verify.$post({
        json: { response },
      });
      if (!verifyRes.ok) {
        const data = (await verifyRes.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(data?.message ?? t().passkeyLoginFailed);
      }
    },
    onSuccess: () => {
      cookies.writeCookie("login_method", "passkey");
      window.location.href = afterSignInHref(props.redirectTo);
    },
  });

  return (
    <div class="flex flex-col gap-2">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        loading={mutation.loading()}
        loadingLabel={t().signingIn}
        onClick={() => mutation.mutate({})}
      >
        {mutation.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-key" />}
        {t().continueWithPasskey}
      </Button>
      {mutation.error() && (
        <NoticeCard tone="danger" icon={false}>
          <span>{mutation.error()?.message}</span>
        </NoticeCard>
      )}
    </div>
  );
}
