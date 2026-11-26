import { apiClient } from "@k2b/cloud/clients/core";
import { cookies } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Button, Notice } from "@k2b/ui/v2";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { Show } from "solid-js";
import { afterSignInHref, confirmationRequestOptions } from "./login-redirect";
import { authMessages } from "./messages";

export default function PasskeyLoginButton(props: {
  redirectTo?: string;
  /** A shared workstation: the page does not remember the method. */
  forget?: boolean;
}) {
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
      const verifyRes = await apiClient.auth.passkeys.authentication.verify.$post(
        {
          json: { response },
        },
        confirmationRequestOptions(props.redirectTo),
      );
      if (!verifyRes.ok) {
        const data = (await verifyRes.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(data?.message ?? t().passkeyLoginFailed);
      }
    },
    onSuccess: () => {
      if (!props.forget) cookies.writeCookie("login_method", "passkey");
      window.location.href = afterSignInHref(props.redirectTo);
    },
  });

  return (
    <>
      <Button icon="key" busy={mutation.loading()} onClick={() => mutation.mutate({})}>
        {mutation.loading() ? t().signingIn : t().continueWithPasskey}
      </Button>
      <Show when={mutation.error()}>{(error) => <Notice tone="bad">{error().message}</Notice>}</Show>
    </>
  );
}
