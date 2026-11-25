import { signOutBrowserSession } from "@k2b/cloud/browser/session";
import { apiClient } from "@k2b/cloud/clients/core";
import { Band, Bar, Button, Check, Notice, Text } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import AuthFrame, { type LegalLinks, useAuthMessages } from "./AuthFrame";

/**
 * `/auth/continue` on v2: accept the terms once, or cancel and sign out. The request, its version and every answer's
 * way on are those of the form before v2.
 */
export default function ConsentScreen(props: {
  appName: string;
  legalLinks: LegalLinks;
  userId: string;
  version: string;
  redirectTo: string;
}) {
  const t = useAuthMessages();
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
    <AuthFrame appName={props.appName} title={t().consentTitle} legalLinks={props.legalLinks}>
      <Band>
        <Text>{t().consentDescription}</Text>
        {/* k2b-ui gap: a Text link opens in the same tab; the documents opened in a new tab before v2. */}
        <Check
          name="accepted"
          checked={accepted()}
          disabled={busy()}
          onChange={setAccepted}
          label={
            <>
              {t().termsPrefix} <Text href="/legal/terms">{t().terms}</Text> {t().consentPrivacyJoin}{" "}
              <Text href="/legal/privacy">{t().privacy}</Text>
              {t().consentPrivacyEnd}
            </>
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
        start={
          <Button variant="text" disabled={busy()} onClick={() => void submit(false)}>
            {t().consentCancel}
          </Button>
        }
        end={
          <Button variant="primary" busy={busy()} disabled={!accepted() || stale()} onClick={() => void submit(true)}>
            {t().consentContinue}
          </Button>
        }
      />
    </AuthFrame>
  );
}
