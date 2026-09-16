import { query } from "@k2b/stdlib/solid";
import { Button, ButtonLink, NoticeCard, PanelDialog, Placeholder, ProgressBar, prompts, useLocale } from "@k2b/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import type { AiQuotaIdentity as Identity } from "@k2b/cloud/shared";
import { createSignal, For, Show } from "solid-js";
import AiQuotaIdentity, { quotaIdentityIcon } from "./AiQuotaIdentity";
import { quotaMessages } from "./ai-quota-messages";
const api = coreClient.admin.core["ai-quotas"];
export default function AiQuotaDetail(props: {
  unit: string;
  who: Identity;
  modelName: (id: string) => string;
  range: string;
  close: () => void;
  changed: () => void;
  saving: (value: boolean) => void;
}) {
  const locale = useLocale(),
    t = () => quotaMessages.resolve([locale()]).t;
  const n = (v: number) => v.toLocaleString(locale(), { maximumSignificantDigits: 6 });
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal("");
  const balance = query.create({
    source: () => props.who,
    load: async (who, { abortSignal }) => {
      const response = await api.balance.$get({ query: { type: who.type, id: who.id } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(t().error);
      return response.json();
    },
  });
  async function reset(scope: string) {
    if (busy()) return;
    if (!(await prompts.confirm(`${props.who.label} · ${props.modelName(scope)}\n\n${t().resetConfirm}`))) return;
    setBusy(true);
    props.saving(true);
    setError("");
    try {
      const response = await api.reset.$post({ json: { type: props.who.type, id: props.who.id, scope, requestId: crypto.randomUUID() } });
      if (!response.ok) {
        const body = await response.json();
        throw new Error("message" in body ? body.message : t().error);
      }
      props.changed();
      await balance.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      props.saving(false);
    }
  }
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.who.label}
        subtitle={t().current}
        icon={quotaIdentityIcon(props.who.type)}
        close={props.close}
        closeDisabled={busy()}
      />
      <PanelDialog.Body>
        <div class="flex flex-col gap-5">
          <Show when={error()}>
            <Placeholder state="error" description={error()} />
          </Show>
          <Show when={balance.loading()}>
            <Placeholder state="loading" />
          </Show>
          <Show when={balance.error()}>
            <Placeholder state="error" description={t().error} action={<Button onClick={() => balance.refresh()}>{t().refresh}</Button>} />
          </Show>
          <Show when={balance.data() && !balance.data()!.enabled}>
            <NoticeCard tone="neutral" title={t().disabled} detail={t().disabledHint} />
          </Show>
          <Show when={balance.data() && !balance.data()!.balances.length}>
            <p class="text-sm text-dimmed">{t().noRules}</p>
          </Show>
          <For each={balance.data()?.balances}>
            {(b) => (
              <section class="ai-quota-balance">
                <h3 class="text-sm font-medium text-primary">{props.modelName(b.scope)}</h3>
                <p class="text-xl tabular-nums text-primary">
                  {n(b.used)} / {b.limit === null ? t().unlimited : n(b.limit)} <span class="text-xs text-dimmed">{props.unit}</span>
                </p>
                <Show when={b.limit !== null && !b.bypassed}>
                  <ProgressBar
                    tone={b.limit !== null && b.used >= b.limit ? "danger" : "info"}
                    size="xs"
                    label={`${props.modelName(b.scope)} ${t().used}`}
                    value={b.limit === 0 ? 100 : (b.used / (b.limit ?? 1)) * 100}
                  />
                </Show>
                <div class="flex flex-wrap justify-between gap-2 text-xs text-dimmed">
                  <span>
                    {t().input}: {n(b.input)} · {t().output}: {n(b.output)}
                  </span>
                  <span>
                    {t().until}: {new Date(b.resetsAt).toLocaleString(locale())}
                  </span>
                </div>
                <div class="ai-quota-source">
                  <p class="text-xs text-dimmed">{t().source}</p>
                  <For each={b.sourceDetails} fallback={<p class="text-sm text-dimmed">{b.sources.join(", ") || t().missing}</p>}>
                    {(s) => <AiQuotaIdentity type={s.principal.type} label={s.displayName} />}
                  </For>
                </div>
                <Show when={b.bypassed}>
                  <p class="text-xs text-dimmed">{t().bypassed}</p>
                </Show>
                <Show when={b.estimated}>
                  <p class="text-xs text-dimmed">
                    {t().estimated}: {n(b.estimated ?? 0)}
                  </p>
                </Show>
                <Show when={b.unknown}>
                  <NoticeCard tone="warning" title={t().unknownStatus} detail={`${t().unknown}: ${n(b.unknown)}. ${t().unknownHint}`} />
                </Show>
                <div>
                  <Button variant="secondary" size="sm" disabled={busy()} onClick={() => void reset(b.scope)}>
                    <i class="ti ti-refresh" aria-hidden="true" />
                    {t().reset}
                  </Button>
                </div>
              </section>
            )}
          </For>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Show when={props.who.type === "user"}>
          <ButtonLink
            variant="ghost"
            size="sm"
            href={`/admin/settings?tab=ai-usage&view=comparisons&userId=${props.who.id}&range=${props.range}`}
          >
            {t().historyLink}
          </ButtonLink>
        </Show>
        <Button variant="secondary" disabled={busy()} onClick={props.close}>
          {t().close}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
