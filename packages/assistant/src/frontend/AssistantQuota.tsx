import type { AiChatQuotaBalance, AiChatQuotaSnapshot } from "@k2b/cloud/shared";
import { dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Button, type ChatUsageSection, IconButton, ProgressBar, useLocale } from "@k2b/ui";
import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
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

/**
 * The budget as one part of the composer's usage control. The part is there as long as a budget may apply: while the
 * reading loads, when it failed, and when an allowance applies to the chosen model.
 */
export function createAssistantQuotaSections(input: {
  quota: {
    data: () => AiChatQuotaSnapshot | null | undefined;
    error: () => unknown;
    loading: () => boolean;
    refreshing: () => boolean;
    refresh: () => void;
  };
  model: () => string;
  modelLabel: () => string;
}): () => readonly ChatUsageSection[] {
  const locale = useLocale(),
    t = () => quotaText.resolve([locale()]).t;
  const state = () => quotaState(input.quota.data(), input.model());
  const failed = () => Boolean(input.quota.error());
  const percent = (value: number) => new Intl.NumberFormat(locale(), { style: "percent" }).format(value / 100);
  const value = () => {
    if (failed() || !input.quota.data()) return failed() ? t().unavailable : undefined;
    const used = state().usedPercent;
    if (state().unlimited) return t().unlimited;
    return used === null ? t().unavailable : t().used({ value: percent(used) });
  };
  const summary = () => {
    const text = t().summary({ value: value() ?? t().unavailable });
    const used = state().usedPercent;
    if (failed() || used === null || used < NEAR_LIMIT_PERCENT) return text;
    return `${text}, ${used >= 100 ? t().exhausted : t().nearLimit}`;
  };
  const section: ChatUsageSection = {
    id: "budget",
    get title() {
      return t().title;
    },
    get percent() {
      return failed() ? null : state().usedPercent;
    },
    warnAt: NEAR_LIMIT_PERCENT,
    get value() {
      return value();
    },
    get summary() {
      return summary();
    },
    content: (
      <QuotaDetails
        snapshot={input.quota.data()}
        state={state()}
        failed={failed()}
        refreshing={input.quota.loading() || input.quota.refreshing()}
        modelLabel={input.modelLabel()}
        onRefresh={input.quota.refresh}
      />
    ),
    onOpen: () => input.quota.refresh(),
  };
  const sections = [section];
  return () => (!input.model() ? [] : failed() || !input.quota.data() || state().balances.length ? sections : []);
}

function QuotaDetails(props: {
  snapshot: AiChatQuotaSnapshot | null | undefined;
  state: ReturnType<typeof quotaState>;
  failed: boolean;
  refreshing: boolean;
  modelLabel: string;
  onRefresh: () => void;
}) {
  const locale = useLocale(),
    t = () => quotaText.resolve([locale()]).t;
  const percent = (value: number) => new Intl.NumberFormat(locale(), { style: "percent" }).format(value / 100);
  // The exact reset time follows the browser's time zone, which the server does not know.
  const [mounted, setMounted] = createSignal(false);
  onMount(() => setMounted(true));
  const refresh = () => (
    <IconButton label={t().refresh} size="xs" loading={props.refreshing} onClick={props.onRefresh}>
      <i class="ti ti-refresh" aria-hidden="true" />
    </IconButton>
  );
  return (
    <Switch>
      <Match when={props.failed}>
        <div class="k2b-chat-usage__row">
          <p role="status">{t().loadFailed}</p>
          <Button size="xs" variant="subtle" loading={props.refreshing} onClick={props.onRefresh}>
            {t().retry}
          </Button>
        </div>
      </Match>
      <Match when={!props.snapshot}>
        <p role="status">{t().loading}</p>
      </Match>
      <Match when={props.snapshot}>
        <For each={props.state.balances}>
          {(balance, index) => {
            const name = () => (balance.scope === "*" ? t().all : props.modelLabel);
            const reset = () => {
              const at = balance.resetsAt ? new Date(balance.resetsAt) : null;
              return at && at.getTime() > Date.now() ? at : null;
            };
            const amount = () =>
              balance.unlimited ? t().unlimited : balance.usedPercent === null ? t().unavailable : percent(balance.usedPercent);
            return (
              <>
                <Show when={balance.usedPercent !== null}>
                  <ProgressBar value={balance.usedPercent ?? 0} size="xs" tone={toneOf(balance.usedPercent)} label={name()} />
                </Show>
                <div class="k2b-chat-usage__row">
                  <p>
                    {name()}
                    <Show when={props.state.balances.length > 1}>{` · ${amount()}`}</Show>
                    <Show when={reset()}>
                      {(at) => (
                        <>
                          {" · "}
                          <time
                            datetime={at().toISOString()}
                            title={mounted() ? dates.formatDateTime(at(), { locale: locale() }) : undefined}
                          >
                            {t().resets({ when: dates.formatTimeSpan(at(), { locale: locale() }) })}
                          </time>
                        </>
                      )}
                    </Show>
                  </p>
                  <Show when={index() === props.state.balances.length - 1}>{refresh()}</Show>
                </div>
              </>
            );
          }}
        </For>
      </Match>
    </Switch>
  );
}
