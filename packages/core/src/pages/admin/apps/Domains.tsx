import { coreClient } from "@k2b/cloud/clients/core";
import { dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Chip, Dialog, Empty, Failed, List, Loading, Menu, type MenuEntry, Notice, Row } from "@k2b/ui/v2";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { failure, STALE } from "./domains-api";
import { domainError, domainsMessages } from "./domains-messages";
import { type AppDomainEntry, aliasesOf, makePrimaryPlan, nextCheckAt, primaries } from "./domains-model";
import { domainsState } from "./domains-state";

const api = coreClient.admin.apps;

export type DomainsProps = {
  app: { id: string; name: string };
  /** Null when the server could not read the domains; the view then offers to try again. */
  initial: AppDomainEntry[] | null;
  timeZone: string;
  /** The server's clock when the page was rendered, so the check countdown never follows a wrong browser clock. */
  serverNow: number;
};

type Step = { ok: boolean; detail?: string | null } | null | undefined;

/**
 * The domains of an app with public pages: each a row with DNS → certificate → reachable, its 301 redirect, the check
 * and a menu to make it primary, redirect or remove it. Every change reads the list again; nothing is kept twice.
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
  /** Asks, then removes; a refusal shows above the list, and an old list is read again. */
  const remove = async (host: string) => {
    if (busy()) return;
    const asked = await Dialog.confirm({
      title: t().removeTitle({ host }),
      description: t().removeText({ host, app: props.app.name }),
      confirm: t().removeConfirm,
    });
    if (!asked) return;
    setBusy(host);
    setProblem(null);
    setUnfinished(null);
    try {
      const response = await api[":appId"].domains[":host"].$delete({ param: { appId: props.app.id, host } }).catch(() => null);
      if (!response?.ok) {
        const code = (await failure(response)).code;
        setProblem(domainError(t(), code));
        if (!STALE.has(code ?? "")) return;
      }
      await reconcile();
    } finally {
      setBusy(null);
    }
  };

  const step = (label: string, value: Step) => {
    const words = `${label} ${value ? (value.ok ? t().stepOk : t().stepFailed) : t().stepOpen}`;
    return value ? <Chip status={value.ok ? "ok" : "bad"}>{words}</Chip> : <Chip>{words}</Chip>;
  };
  const DomainRow = (row: { domain: AppDomainEntry }) => {
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
    const checked = () =>
      domain().status
        ? t().checkedAt({
            when: dates.formatTimeSpan(domain().status!.checkedAt, { locale: locale(), timeZone: props.timeZone, base: new Date(now()) }),
          })
        : t().checking;
    const items = (): MenuEntry[] => [
      ...(domain().redirectTo
        ? [
            { icon: "star", label: t().makePrimary, onClick: () => void change(domain().host, makePrimaryPlan(list(), domain().host)) },
            {
              icon: "arrow-back-up",
              label: t().stopRedirect,
              onClick: () => void change(domain().host, [{ host: domain().host, redirectTo: null }]),
            },
          ]
        : aliases().length === 0
          ? primaries(list())
              .filter((target) => target.host !== domain().host)
              .map((target) => ({
                icon: "arrow-forward-up",
                label: t().redirectTo({ host: target.host }),
                onClick: () => void change(domain().host, [{ host: domain().host, redirectTo: target.host }]),
              }))
          : []),
      aliases().length > 0
        ? { icon: "trash", label: t().remove, meta: t().removeReferenced, disabled: true }
        : { icon: "trash", label: t().remove, danger: true, onClick: () => void remove(domain().host) },
    ];
    return (
      <Row
        lines={[
          domain().host,
          domain().redirectTo ? t().redirects({ host: domain().redirectTo! }) : aliases().length > 0 ? t().primary : checked(),
          failed() ?? checked(),
        ]}
        icon="world"
        marks={
          <>
            {step(t().dns, domain().status?.dns)}
            {step(t().certificate, domain().status?.certificate)}
            {step(t().reachable, domain().status?.reachable)}
          </>
        }
        action={{
          label: wait() > 0 ? t().checkIn({ seconds: wait() }) : t().check,
          icon: "refresh",
          disabled: wait() > 0 || busy() !== null,
          onClick: () => void check(domain().host),
        }}
        end={<Menu label={t().actionsFor({ host: domain().host })} disabled={busy() !== null} items={items()} />}
      />
    );
  };
  // Primaries first, each followed by its aliases, so a redirect sits under its target.
  const ordered = () => {
    const list = domains.data() ?? [];
    return primaries(list).flatMap((primary) => [primary, ...aliasesOf(list, primary.host)]);
  };
  return (
    <>
      <Show when={problem()}>
        {(text) => (
          <Notice
            tone="bad"
            title={unfinished() ? undefined : t().changeFailed}
            actions={
              unfinished()
                ? [{ label: t().finish, disabled: busy() !== null, onClick: () => void change(unfinished()![0]!.host, unfinished()!) }]
                : undefined
            }
          >
            {text()}
          </Notice>
        )}
      </Show>
      <Show when={!domains.error()} fallback={<Failed text={t().loadFailed} onRetry={() => void domains.refresh()} />}>
        <Show when={domains.data()} fallback={<Loading rows={2} lines={3} />}>
          <Show when={ordered().length > 0} fallback={<Empty icon="world" text={t().empty} />}>
            <List label={t().title}>
              <For each={ordered()}>{(domain) => <DomainRow domain={domain} />}</For>
            </List>
          </Show>
        </Show>
      </Show>
    </>
  );
}
