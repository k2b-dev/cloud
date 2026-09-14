import type { AiChatQuotaSnapshot } from "@k2b/cloud/shared";
import { query } from "@k2b/stdlib/solid";
import { Button, Chat, Format, ProgressBar, useLocale } from "@k2b/ui";
import { For, Show, onCleanup, onMount } from "solid-js";
import { assistantApi } from "../api/client";
import { quotaText } from "./quota-messages";

export function quotaState(snapshot: AiChatQuotaSnapshot | null | undefined, model: string) {
  const balances = snapshot?.enabled ? snapshot.balances.filter((b) => b.scope === "*" || b.scope === model) : [];
  const finite = balances.filter((b) => !b.bypassed && b.limit !== null);
  const unknown = finite.some((b) => b.unknown > 0);
  const remaining = finite.length ? Math.min(...finite.map((b) => (b.limit === 0 ? 0 : Math.max(0, 100 * (1 - b.used / b.limit!))))) : null;
  return { balances, unknown, remaining };
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
  loading?: boolean;
  onRefresh: () => void;
}) {
  const locale = useLocale(),
    t = () => quotaText.resolve([locale()]).t;
  const state = () => quotaState(props.snapshot, props.model);
  const failed = () => Boolean(props.error);
  const percent = (value: number) => `${Math.floor(value).toLocaleString(locale())} %`;
  const summary = () =>
    failed()
      ? t().unavailable
      : state().unknown
        ? t().unknownShort
        : state().remaining === null
          ? t().unlimited
          : t().remaining({ percent: percent(state().remaining!) });
  const number = (value: number) => value.toLocaleString(locale());
  return (
    <Show when={props.model && (state().balances.length || (failed() && props.snapshot?.enabled !== false))}>
      <Chat.ContextPopup
        type="button"
        class="inline-flex cursor-pointer items-center gap-1 rounded px-1 py-1 text-xs text-muted hover:text-default focus-visible:outline focus-visible:outline-2"
        aria-label={`${t().title}: ${summary()}`}
        content={
          <div class="flex flex-col gap-4" style="width:20rem;max-width:calc(100vw - 3rem)">
            <strong>{t().title}</strong>
            <Show
              when={!failed()}
              fallback={
                <p class="text-sm text-muted" role="status">
                  {t().loadFailed}
                </p>
              }
            >
              <For each={state().balances}>
                {(balance) => {
                  const unlimited = () => balance.bypassed || balance.limit === null;
                  const label = () => (balance.scope === "*" ? t().all : props.modelLabel);
                  const rest = () => (balance.limit ? Math.max(0, 100 * (1 - balance.used / balance.limit)) : 0);
                  return (
                    <section class="flex flex-col gap-2">
                      <div class="flex items-center justify-between gap-3 text-sm">
                        <span class="font-medium">{label()}</span>
                        <span>
                          {unlimited() ? t().unlimited : balance.unknown ? t().unknownShort : t().remaining({ percent: percent(rest()) })}
                        </span>
                      </div>
                      <Show when={!unlimited() && !balance.unknown}>
                        <ProgressBar
                          value={100 - rest()}
                          size="xs"
                          tone={rest() <= 10 ? "danger" : "info"}
                          label={`${label()}: ${t().used}`}
                        />
                      </Show>
                      <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                        <span>
                          {number(balance.used)}
                          {unlimited() ? ` ${t().tokens}` : ` / ${number(balance.limit!)} ${t().tokens}`}
                        </span>
                        <Show when={!unlimited()}>
                          <span>
                            {t().reset} <Format.RelativeTime value={balance.resetsAt} />
                          </span>
                        </Show>
                      </div>
                      <Show when={!unlimited() && balance.unknown}>
                        <p class="text-xs text-muted">{t().unknown}</p>
                      </Show>
                    </section>
                  );
                }}
              </For>
              <Show when={state().remaining === 0 && !state().unknown}>
                <p class="text-sm text-muted" role="status">
                  {t().exhausted}
                </p>
              </Show>
            </Show>
            <p class="text-xs text-muted">{t().scope}</p>
            <Button size="sm" variant="ghost" disabled={props.loading} onClick={props.onRefresh}>
              {props.loading ? t().refreshing : t().refresh}
            </Button>
          </div>
        }
      >
        <span aria-hidden="true">·</span>
        <span class={state().remaining !== null && state().remaining! <= 10 ? "text-danger" : undefined}>{summary()}</span>
      </Chat.ContextPopup>
    </Show>
  );
}
