import { coreClient } from "@k2b/cloud/clients/core";
import { dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Button, Dropdown, type DropdownAction, NoticeCard, Skeleton, StatusBadge, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { failure, openRemoveDomainDialog } from "./domains-dialogs";
import { domainError, domainsMessages } from "./domains-messages";
import { type AppDomainEntry, aliasesOf, makePrimaryPlan, nextCheckAt, primaries } from "./domains-model";
import { domainsState } from "./domains-state";

const api = coreClient.admin.apps;

export type DomainsProps = {
  app: { id: string; name: string };
  /** Null when the server could not read the domains; the column then offers to try again. */
  initial: AppDomainEntry[] | null;
  timeZone: string;
  /** The server's clock when the page was rendered, so the check countdown never follows a wrong browser clock. */
  serverNow: number;
};

/**
 * The domains of an app with public pages: each with DNS → certificate → reachable, its 301 redirect, and the actions
 * to check, make it primary, redirect or remove it. Every change reads the list again; nothing is kept twice.
 */
export default function Domains(props: DomainsProps) {
  const locale = useLocale();
  const t = () => domainsMessages.resolve([locale()]).t;
  const [now, setNow] = createSignal(Date.now());
  const [clicked, setClicked] = createSignal<Record<string, number>>({});
  const [problem, setProblem] = createSignal<string | null>(null);
  /** Changes still to run when a promotion stopped halfway: the list is consistent, the request unfinished. */
  const [unfinished, setUnfinished] = createSignal<Array<{ host: string; redirectTo: string | null }> | null>(null);
  // Server time minus browser time: the 60 s window runs on the server's clock, the countdown on the browser's.
  const [skew, setSkew] = createSignal(props.serverNow - Date.now());
  const busy = domainsState.busy;
  const setBusy = domainsState.setBusy;
  const ticker = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(ticker));

  const domains = query.create({
    source: () => ({ revision: domainsState.revision() }),
    initial: props.initial ? { source: { revision: 0 }, data: props.initial } : undefined,
    isSameSource: (a, b) => a.revision === b.revision,
    load: async (_, { abortSignal }): Promise<AppDomainEntry[]> => {
      const response = await api[":appId"].domains.$get({ param: { appId: props.app.id } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(t().loadFailed);
      const date = Date.parse(response.headers.get("date") ?? "");
      if (Number.isFinite(date)) setSkew(date - Date.now());
      return ((await response.json()) as { domains: AppDomainEntry[] }).domains;
    },
  });
  createEffect(
    on(
      () => domains.data(),
      (data) => data && domainsState.setDomains(data),
    ),
  );
  /** Reads the list again and keeps every action off until it is back, so no action starts from an old list. */
  const reconcile = async () => {
    await domains.refresh().catch(() => undefined);
  };

  /** Runs redirect changes in order; a refusal stops and stays visible, and a promotion stopped halfway can finish. */
  const change = async (host: string, steps: Array<{ host: string; redirectTo: string | null }>) => {
    if (busy()) return;
    setBusy(host);
    setProblem(null);
    setUnfinished(null);
    try {
      for (const [index, step] of steps.entries()) {
        const response = await api[":appId"].domains[":host"]
          .$patch({ param: { appId: props.app.id, host: step.host }, json: { redirectTo: step.redirectTo } })
          .catch(() => null);
        if (!response?.ok) {
          const message = domainError(t(), (await failure(response)).code);
          if (index > 0) {
            setUnfinished(steps.slice(index));
            setProblem(`${t().partial} ${message}`);
          } else setProblem(message);
          break;
        }
      }
    } finally {
      await reconcile();
      setBusy(null);
    }
  };
  const check = async (host: string) => {
    if (busy()) return;
    setBusy(host);
    setProblem(null);
    setClicked((value) => ({ ...value, [host]: Date.now() }));
    try {
      const response = await api[":appId"].domains[":host"].check.$post({ param: { appId: props.app.id, host } }).catch(() => null);
      if (!response?.ok) setProblem(domainError(t(), (await failure(response)).code));
    } finally {
      await reconcile();
      setBusy(null);
    }
  };

  const step = (label: string, value: { ok: boolean } | null | undefined) => (
    <StatusBadge
      variant="dot"
      tone={value ? (value.ok ? "ok" : "error") : "neutral"}
      label={`${label} ${value ? (value.ok ? t().stepOk : t().stepFailed) : t().stepOpen}`}
    />
  );
  const Row = (row: { domain: AppDomainEntry }) => {
    const domain = () => row.domain;
    const list = () => domains.data() ?? [];
    const aliases = () => aliasesOf(list(), domain().host);
    // Both sides of the comparison on the server's clock: a browser clock that runs ahead or behind does not matter.
    const wait = () => {
      const clickedAt = clicked()[domain().host];
      return Math.max(
        0,
        Math.ceil((nextCheckAt(domain(), clickedAt === undefined ? undefined : clickedAt + skew()) - (now() + skew())) / 1000),
      );
    };
    const failed = () =>
      [domain().status?.dns, domain().status?.certificate, domain().status?.reachable].find((value) => value && !value.ok)?.detail;
    const items = (): DropdownAction[] => [
      ...(domain().redirectTo
        ? [
            {
              icon: "ti ti-star",
              label: t().makePrimary,
              action: () => void change(domain().host, makePrimaryPlan(list(), domain().host)),
            },
            {
              icon: "ti ti-arrow-back-up",
              label: t().stopRedirect,
              action: () => void change(domain().host, [{ host: domain().host, redirectTo: null }]),
            },
          ]
        : aliases().length === 0
          ? primaries(list())
              .filter((target) => target.host !== domain().host)
              .map((target) => ({
                icon: "ti ti-arrow-forward-up",
                label: t().redirectTo({ host: target.host }),
                action: () => void change(domain().host, [{ host: domain().host, redirectTo: target.host }]),
              }))
          : []),
      aliases().length > 0
        ? { icon: "ti ti-trash", label: t().remove, description: t().removeReferenced, disabled: true as const }
        : {
            icon: "ti ti-trash",
            label: t().remove,
            variant: "danger" as const,
            action: () => void openRemoveDomainDialog(props.app, domain().host, locale(), () => void reconcile()),
          },
    ];
    return (
      <div
        class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 rounded-lg px-2.5 py-2.5 hover:bg-(--k2b-hover)"
        data-domain={domain().host}
      >
        <div class="min-w-0">
          <div class="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
            <span class="truncate font-mono">{domain().host}</span>
            <Show when={!domain().redirectTo && aliases().length > 0}>
              <StatusBadge tone="info" icon={null} label={t().primary} />
            </Show>
          </div>
          <Show when={domain().redirectTo}>
            {(target) => <div class="mt-0.5 text-[12.5px] text-dimmed">{t().redirects({ host: target() })}</div>}
          </Show>
          <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]" data-domain-status>
            {step(t().dns, domain().status?.dns)}
            {step(t().certificate, domain().status?.certificate)}
            {step(t().reachable, domain().status?.reachable)}
          </div>
          <Show when={failed()}>{(detail) => <div class="mt-0.5 text-[12.5px] break-words text-secondary">{detail()}</div>}</Show>
          <div class="mt-1 flex flex-wrap items-center gap-x-2 text-[12.5px] text-dimmed">
            <span>
              {domain().status
                ? t().checkedAt({
                    when: dates.formatTimeSpan(domain().status!.checkedAt, {
                      locale: locale(),
                      timeZone: props.timeZone,
                      base: new Date(now()),
                    }),
                  })
                : t().checking}
            </span>
            <Button
              size="xs"
              variant="text"
              disabled={wait() > 0 || busy() !== null}
              loading={busy() === domain().host}
              aria-label={`${t().check} ${domain().host}`}
              onClick={() => void check(domain().host)}
            >
              {wait() > 0 ? t().checkIn({ seconds: wait() }) : t().check}
            </Button>
          </div>
        </div>
        <Dropdown.Root position="bottom-right" phone="sheet" label={t().actionsFor({ host: domain().host })} items={items()}>
          <Dropdown.Trigger iconOnly label={t().actionsFor({ host: domain().host })} size="xs" variant="ghost" disabled={busy() !== null}>
            <i class="ti ti-dots" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </div>
    );
  };
  // Primaries first, each followed by its aliases, so a redirect sits under its target.
  const ordered = () => {
    const list = domains.data() ?? [];
    return primaries(list).flatMap((primary) => [primary, ...aliasesOf(list, primary.host)]);
  };
  return (
    <div class="flex flex-col" data-domains={props.app.id}>
      <Show when={problem()}>
        {(text) => (
          <NoticeCard tone="danger" icon="ti ti-alert-circle" role="alert" class="mb-2">
            <span>
              <Show when={!unfinished()}>
                <b>{t().changeFailed}</b>{" "}
              </Show>
              {text()}
            </span>
            <Show when={unfinished()}>
              {(steps) => (
                <span class="mt-1.5 block">
                  <Button size="sm" variant="secondary" disabled={busy() !== null} onClick={() => void change(steps()[0]!.host, steps())}>
                    {t().finish}
                  </Button>
                </span>
              )}
            </Show>
          </NoticeCard>
        )}
      </Show>
      <Show
        when={!domains.error()}
        fallback={
          <div class="flex flex-col items-start gap-2 px-2.5 py-2 text-[13.5px] text-secondary">
            <span>
              <i class="ti ti-alert-triangle text-(--k2b-danger-text)" aria-hidden="true" /> {t().loadFailed}
            </span>
            <Button size="sm" variant="secondary" loading={domains.refreshing()} onClick={() => void domains.refresh()}>
              <i class="ti ti-refresh" aria-hidden="true" />
              {t().retry}
            </Button>
          </div>
        }
      >
        <Show
          when={domains.data()}
          fallback={
            <div class="flex flex-col gap-0.5" aria-busy="true">
              <Skeleton class="h-[92px] rounded-lg" />
              <Skeleton class="h-[92px] w-3/4 rounded-lg" />
            </div>
          }
        >
          <Show when={ordered().length > 0} fallback={<p class="mx-2.5 my-1 text-[13.5px] text-dimmed">{t().empty}</p>}>
            <div class="flex flex-col gap-0.5">
              <For each={ordered()}>{(domain) => <Row domain={domain} />}</For>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
