import type { AiChatQuotaBalance, AiChatQuotaSnapshot } from "@k2b/cloud/shared";
import { dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Chat, ProgressBar, ProgressRing, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { assistantApi } from "../api/client";
import { quotaText } from "./quota-messages";

/** Usage share from which an allowance reads as almost used up. */
const NEAR_LIMIT_PERCENT = 80;

export type QuotaTone = "info" | "warning" | "danger";
const toneOf = (percent: number | null): QuotaTone =>
  percent === null || percent >= 100 ? "danger" : percent >= NEAR_LIMIT_PERCENT ? "warning" : "info";

/** The allowances that apply to one model. The fullest one decides the indicator, because it blocks first. */
export function quotaState(snapshot: AiChatQuotaSnapshot | null | undefined, model: string) {
  const free = Boolean(snapshot?.unlimitedModels?.includes(model));
  const balances: AiChatQuotaBalance[] = snapshot?.enabled
    ? snapshot.balances
        .filter((b) => b.scope === "*" || b.scope === model)
        .map((b) => (free ? { ...b, unlimited: true, usedPercent: null, resetsAt: null } : b))
    : [];
  const finite = balances.filter((b) => !b.unlimited);
  const unknown = finite.some((b) => b.usedPercent === null);
  const usedPercent = finite.length && !unknown ? Math.max(...finite.map((b) => b.usedPercent ?? 0)) : null;
  return { balances, unlimited: balances.length > 0 && finite.length === 0, unknown, usedPercent };
}

export function createAssistantQuota(initial: AiChatQuotaSnapshot | null | undefined) {
  const request = query.create({
    source: () => "own-quotas",
    initial: initial ? { source: "own-quotas", data: initial } : undefined,
    load: (_source, { abortSignal }) => assistantApi.quotas(abortSignal),
  });
  const refresh = () => {
    if (!request.loading() && !request.refreshing()) void request.refresh();
  };
  onMount(() => {
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    const timer = setInterval(visible, 30_000);
    onCleanup(() => {
      clearInterval(timer);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    });
  });
  return { ...request, refresh };
}

export default function AssistantQuota(props: {
  snapshot?: AiChatQuotaSnapshot | null;
  model: string;
  modelLabel: string;
  error?: unknown;
  onRefresh: () => void;
}) {
  const locale = useLocale(),
    t = () => quotaText.resolve([locale()]).t;
  const state = () => quotaState(props.snapshot, props.model);
  const failed = () => Boolean(props.error);
  const percent = (value: number) => new Intl.NumberFormat(locale(), { style: "percent" }).format(value / 100);
  const value = (usedPercent: number | null, unlimited: boolean) =>
    unlimited ? t().unlimited : usedPercent === null ? t().unavailable : percent(usedPercent);
  const summary = () => {
    if (failed()) return t().summary({ value: t().unavailable });
    const used = state().usedPercent;
    const text = t().summary({ value: value(used, state().unlimited) });
    if (used === null || used < NEAR_LIMIT_PERCENT) return text;
    return `${text}, ${used >= 100 ? t().exhausted : t().nearLimit}`;
  };
  // The exact reset time follows the browser's time zone, which the server does not know.
  const [mounted, setMounted] = createSignal(false);
  onMount(() => setMounted(true));

  return (
    <Show
      when={props.snapshot}
      fallback={
        // Usage is not known yet: keep the indicator's box so the composer does not move once it is.
        <span class="k2b-chat-context" data-usage="loading" aria-hidden="true">
          <ProgressRing value={0} />
        </span>
      }
    >
      <Show when={props.model && state().balances.length}>
        <Chat.ContextPopup
          aria-label={summary()}
          data-usage={
            failed() ? "unavailable" : state().unlimited ? "unlimited" : state().unknown ? "unknown" : toneOf(state().usedPercent)
          }
          onOpen={props.onRefresh}
          content={
            <Chat.ContextPanel title={t().title}>
              <Show when={!failed()} fallback={<p role="status">{t().loadFailed}</p>}>
                <For each={state().balances}>
                  {(balance) => {
                    const reset = () => {
                      const at = balance.resetsAt ? new Date(balance.resetsAt) : null;
                      return at && at.getTime() > Date.now() ? at : null;
                    };
                    return (
                      <section>
                        <dl>
                          <div>
                            <dt>{state().balances.length === 1 ? t().used : balance.scope === "*" ? t().all : props.modelLabel}</dt>
                            <dd>{value(balance.usedPercent, balance.unlimited)}</dd>
                          </div>
                        </dl>
                        <Show when={balance.usedPercent !== null}>
                          <ProgressBar
                            value={balance.usedPercent ?? 0}
                            size="xs"
                            tone={toneOf(balance.usedPercent)}
                            label={state().balances.length === 1 ? t().title : balance.scope === "*" ? t().all : props.modelLabel}
                          />
                        </Show>
                        <Show when={reset()}>
                          {(at) => (
                            <p>
                              <time
                                datetime={at().toISOString()}
                                title={mounted() ? dates.formatDateTime(at(), { locale: locale() }) : undefined}
                              >
                                {t().resets({ when: dates.formatTimeSpan(at(), { locale: locale() }) })}
                              </time>
                            </p>
                          )}
                        </Show>
                      </section>
                    );
                  }}
                </For>
              </Show>
            </Chat.ContextPanel>
          }
        >
          <Show when={failed() || !state().unlimited} fallback={<i class="ti ti-infinity" aria-hidden="true" />}>
            <ProgressRing value={failed() ? 0 : (state().usedPercent ?? 0)} tone={failed() ? "info" : toneOf(state().usedPercent)} />
          </Show>
        </Chat.ContextPopup>
      </Show>
    </Show>
  );
}
