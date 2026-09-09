import { Button, Checkbox, NoticeCard, useLocale } from "@k2b/ui";
import { apiClient } from "@k2b/cloud/clients/core";
import { createSignal, Show } from "solid-js";
import { authMessages } from "./messages";

export default function ConsentForm(props: { version: string; redirectTo: string }) {
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
      const response = accept
        ? await apiClient.auth["legal-consent"].$post({ json: { accepted: true, version: props.version } })
        : await apiClient.auth.logout.$post();
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
    <form
      class="mt-6 flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(true);
      }}
    >
      <Checkbox
        value={accepted}
        onValueChange={setAccepted}
        disabled={busy()}
        label={
          <span>
            {t().termsPrefix}{" "}
            <a href="/legal/terms" target="_blank" rel="noopener" class="underline">
              {t().terms}
            </a>{" "}
            {t().consentPrivacyJoin}{" "}
            <a href="/legal/privacy" target="_blank" rel="noopener" class="underline">
              {t().privacy}
            </a>
            {t().consentPrivacyEnd}
          </span>
        }
      />
      <Show when={error()}>
        <NoticeCard tone="danger">{error()}</NoticeCard>
      </Show>
      <Show when={stale()}>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          {t().consentReload}
        </Button>
      </Show>
      <Button type="submit" size="lg" loading={busy()} disabled={!accepted() || stale()}>
        {t().consentContinue}
      </Button>
      <Button type="button" variant="secondary" disabled={busy()} onClick={() => void submit(false)}>
        {t().consentCancel}
      </Button>
    </form>
  );
}
