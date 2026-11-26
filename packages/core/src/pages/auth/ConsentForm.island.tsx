import { signOutBrowserSession } from "@k2b/cloud/browser/session";
import { apiClient } from "@k2b/cloud/clients/core";
import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Check, Notice, Text } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { authMessages } from "./messages";

export default function ConsentForm(props: { userId: string; version: string; redirectTo: string }) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  const [accepted, setAccepted] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [stale, setStale] = createSignal(false);
  const submit = async (accept: boolean) => {
    if (busy() || (accept && (!accepted() || stale()))) return;
    setBusy(true);
    setError(undefined);
    try {
      if (!accept) {
        await signOutBrowserSession(props.userId, t().consentFailed);
        window.location.assign("/auth/login");
        return;
      }
      // Authentication and consent middleware also return 401/409 before the handler.
      const response: Pick<Response, "ok" | "status"> = await apiClient.auth["legal-consent"].$post({
        json: { accepted: true, version: props.version },
      });
      if (!response.ok) {
        if (response.status === 409) {
          setStale(true);
          throw new Error(t().consentChanged);
        }
        if (response.status === 401) {
          window.location.assign(`/auth/login?${new URLSearchParams({ redirectTo: props.redirectTo })}`);
          return;
        }
        throw new Error(t().consentFailed);
      }
      window.location.assign(accept ? props.redirectTo : "/auth/login");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t().consentFailed);
      setBusy(false);
    }
  };
  return (
    // The nightly, release and Chat smokes read the pending version from this attribute.
    <form
      data-legal-version={props.version}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(true);
      }}
    >
      <Band>
        <Check
          checked={accepted()}
          onChange={setAccepted}
          disabled={busy() || stale()}
          label={
            <Text>
              {t().termsPrefix}{" "}
              <a href="/legal/terms" target="_blank" rel="noopener">
                {t().terms}
              </a>{" "}
              {t().consentPrivacyJoin}{" "}
              <a href="/legal/privacy" target="_blank" rel="noopener">
                {t().privacy}
              </a>
              {t().consentPrivacyEnd}
            </Text>
          }
        />
      </Band>
      <Show when={error()}>
        {(message) => (
          <Notice
            tone="bad"
            actions={stale() ? [{ label: t().consentReload, icon: "refresh", onClick: () => window.location.reload() }] : undefined}
          >
            {message()}
          </Notice>
        )}
      </Show>
      <Bar
        end={
          <>
            <Button type="button" disabled={busy()} onClick={() => void submit(false)}>
              {t().consentCancel}
            </Button>
            <Button variant="primary" type="submit" busy={busy()} disabled={!accepted() || stale()}>
              {t().consentContinue}
            </Button>
          </>
        }
      />
    </form>
  );
}
