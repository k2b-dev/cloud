import { Button, ButtonLink, Disclosure, NoticeCard, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { aiAreaHref } from "./area";
import { aiAdminApi, readAiAdmin, reloadAiArea } from "./client";
import { aiAreaMessages } from "./messages";
import { type AiProviderState, aiProviderFailureText, formatAiTime } from "./presentation";

/**
 * The provider's failure where the administration works: what is wrong, since when, and the way out. A retry tests
 * the stored connection again and shows the new state.
 */
export function AiProviderNotice(props: {
  providerId: string;
  providerLabel: string;
  state: AiProviderState;
  statusMessage: string | null;
  statusCode?: string | null;
  status?: string;
  checkedAt: string | null;
  /** Leave out the connection link inside the connection itself. */
  inConnection?: boolean;
}) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const retry = async () => {
    setBusy(true);
    setError("");
    try {
      await readAiAdmin(await aiAdminApi.providers[":id"].test.$post({ param: { id: props.providerId } }), t().loadFailed);
      reloadAiArea();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().loadFailed);
      setBusy(false);
    }
  };
  const time = () => formatAiTime(locale(), props.checkedAt);
  const retryButton = () => (
    <Button type="button" variant="secondary" size="sm" loading={busy()} onClick={() => void retry()}>
      <i class="ti ti-refresh" aria-hidden="true" />
      {t().retry}
    </Button>
  );
  return (
    <>
      <Show when={props.state === "unreachable"}>
        <div class="pb-2">
          <NoticeCard
            tone="danger"
            icon="ti ti-plug-x"
            role="alert"
            title={t().unreachTitle({ p: props.providerLabel })}
            detail={[aiProviderFailureText(t(), props.status, props.statusCode), time() ? t().unreachSince({ time: time() }) : ""]
              .filter(Boolean)
              .join(" ")}
          >
            <Show when={props.statusMessage || props.statusCode}>
              <Disclosure summary={t().technicalDetails} surface="plain">
                <p class="break-words text-dimmed">{[props.statusCode, props.statusMessage].filter(Boolean).join(" · ")}</p>
              </Disclosure>
            </Show>
            <div class="flex flex-wrap gap-2">
              {retryButton()}
              <Show when={!props.inConnection}>
                <ButtonLink variant="secondary" size="sm" href={aiAreaHref({ sec: "providers", p: props.providerId, pane: "conn" })}>
                  <i class="ti ti-pencil" aria-hidden="true" />
                  {t().editConn}
                </ButtonLink>
              </Show>
            </div>
            <Show when={error()}>
              <p class="text-(--k2b-danger-text)">{error()}</p>
            </Show>
          </NoticeCard>
        </div>
      </Show>
      <Show when={props.state === "badkey"}>
        <div class="pb-2">
          <NoticeCard
            tone="danger"
            icon="ti ti-key"
            role="alert"
            title={t().badKeyTitle({ p: props.providerLabel })}
            detail={[t().testFailKey, time() ? t().badKeySince({ time: time() }) : ""].filter(Boolean).join(" ")}
          >
            <Show when={props.statusMessage || props.statusCode}>
              <Disclosure summary={t().technicalDetails} surface="plain">
                <p class="break-words text-dimmed">{[props.statusCode, props.statusMessage].filter(Boolean).join(" · ")}</p>
              </Disclosure>
            </Show>
            <div class="flex flex-wrap gap-2">
              <Show when={!props.inConnection}>
                <ButtonLink
                  variant="secondary"
                  size="sm"
                  href={aiAreaHref({ sec: "providers", p: props.providerId, pane: "conn" }, { focus: "key" })}
                >
                  <i class="ti ti-key" aria-hidden="true" />
                  {t().editKey}
                </ButtonLink>
              </Show>
              {retryButton()}
            </div>
            <Show when={error()}>
              <p class="text-(--k2b-danger-text)">{error()}</p>
            </Show>
          </NoticeCard>
        </div>
      </Show>
    </>
  );
}
