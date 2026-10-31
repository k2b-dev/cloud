import type { AppAccessEditorProps } from "@k2b/cloud/access/ui";
import type { AppDetails } from "@k2b/cloud/contracts";
import { appAccentStyle } from "@k2b/cloud/ssr/app-appearance";
import { AppWorkspace, ButtonLink, NoticeCard, Placeholder, StatusBadge, ViewTabs } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import Access from "./Access.island";
import AddApp from "./AddApp.island";
import AppRowMenu from "./AppRowMenu.island";
import Domains, { type DomainsProps } from "./Domains.island";
import DomainsAdd from "./DomainsAdd.island";
import { domainsMessages } from "./domains-messages";
import { type AppDomainEntry, domainHealthy, primaries } from "./domains-model";
import { type AppsFormat, providerValues } from "./format";
import Keys, { type KeysProps } from "./Keys.island";
import KeysCreate from "./KeysCreate.island";
import { keysMessages } from "./keys-messages";
import MovedNotice from "./MovedNotice.island";
import { appDetailsMessages } from "./messages";
import {
  type AppEntry,
  type AppHint,
  type AppStatusKind,
  type AppStatusWindow,
  type AppsQuery,
  type AppView,
  appsHref,
  countStatuses,
  HINT_PRESENTATION,
  routeSummary,
  WINDOWS,
} from "./model";
import ProviderRetry from "./ProviderRetry.island";
import ProviderValue from "./ProviderValue.island";
import { type AppsPageMessages, appsPageMessages } from "./page-messages";
import Redeliver from "./Redeliver.island";
import RemoveApp from "./RemoveApp.island";

export type AppPageData = {
  entry: AppEntry;
  /** Null when Core could not read events and notifications; access and keys stay usable. */
  details: AppDetails | null;
  /** Name of the newest revoked key, for the "key revoked" hint. */
  revokedKeyName: string | null;
  /** Providers that did not answer for this app. */
  providerFailures: readonly string[];
  /** The app's access rule as one phrase, for a rule the app fixes itself. */
  accessRule: string;
  /** Core and Gateway are platform services and have no app keys. */
  keysSupported: boolean;
  /** The domains of an app with public pages; null for an app without them, which has no Domains row. */
  domains: readonly AppDomainEntry[] | "failed" | null;
  /** Fibel pages for the key hints: recovering a key and switching from the environment to a key. */
  docs: { recover: string | null; migrate: string | null };
  /** Display names of known apps by ID, for publishers of heard events. */
  appNames: ReadonlyMap<string, string>;
};

export type RouteRow = {
  prefix: string;
  requests: number | null;
  errors: number | null;
  router: "active" | "missing" | "unknown";
  owner: string | null;
};

export type DetailData =
  | { view: "access"; rule: string; editor: AppAccessEditorProps | null }
  | { view: "keys"; keys: KeysProps }
  | { view: "domains"; domains: DomainsProps }
  | { view: "events" }
  | {
      view: "routes";
      window: AppStatusWindow;
      /** One table per provider that answered, each with its own source line; one table without numbers if none did. */
      tables: ReadonlyArray<{ provider: string | null; rows: readonly RouteRow[] }>;
      failures: readonly string[];
      routerKnown: boolean;
      avgMs: number | null;
      telemetryHref: string | null;
      routesHref: string | null;
    }
  | {
      view: "runtime";
      release: string | null;
      build: string | null;
      sync: string | null;
      baseUrl: string | null;
      heartbeatAt: string | null;
      startedAt: string | null;
      issues: ReadonlyArray<{ severity: "warn" | "error"; message: string }>;
      instances: ReadonlyArray<{ hostname: string; startedAt: string; via: "key" | "env" | "unknown"; keyName: string | null }>;
      inRail: boolean;
      adminHref: string | null;
      capabilities: number | null;
      capabilitiesHref: string | null;
    }
  | {
      view: "errors";
      /** Each provider's failed requests under its own name: at most one page each, the rest in its telemetry. */
      groups: ReadonlyArray<{
        provider: string;
        failedRequests: ReadonlyArray<{ at: string; method: string; path: string; status: number }>;
        total: number | null;
      }>;
      failures: readonly string[];
      telemetryHref: string | null;
      logsHref: string | null;
    };

export type AppsViewData = {
  locale: string;
  format: AppsFormat;
  query: AppsQuery;
  list:
    | { state: "failed" }
    | {
        state: "ok";
        apps: readonly AppEntry[];
        issues: ReadonlyArray<{ key: string; reason: string }>;
        unchecked: number;
        logsHref: string | null;
      };
  app: AppPageData | null;
  detail: DetailData | null;
};

const LINK_ICON: Record<string, string> = {
  logs: "ti ti-list-details",
  metrics: "ti ti-chart-dots",
  routes: "ti ti-route",
  capabilities: "ti ti-plug-connected",
  other: "ti ti-external-link",
};

const STATUS_TONE: Record<AppStatusKind, "ok" | "warning" | "error" | "neutral"> = {
  ok: "ok",
  warn: "warning",
  error: "error",
  idle: "neutral",
};

const statusLabel = (t: AppsPageMessages, status: AppStatusKind) =>
  ({ ok: t.statusOk, warn: t.statusWarn, error: t.statusError, idle: t.statusIdle })[status];

/** The app's state as a dot and a word, never as colour alone. */
function Status(props: { t: AppsPageMessages; status: AppStatusKind }) {
  return <StatusBadge variant="dot" tone={STATUS_TONE[props.status]} label={statusLabel(props.t, props.status)} />;
}

function Tile(props: { icon: string; accent: string | null }) {
  return (
    <span
      class="app-accent-scope k2b-icon-tile app-accent-text flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
      style={appAccentStyle(props.accent ?? undefined)}
      aria-hidden="true"
    >
      <i class={props.icon || "ti ti-apps"} />
    </span>
  );
}

/** The one-line version of a hint, for the list. */
function hintShort(t: AppsPageMessages, f: AppsFormat, hint: AppHint): string {
  switch (hint.kind) {
    case "startRejected":
      return t.hintStartRejectedShort({ reason: hint.reason });
    case "notRunning":
      return t.hintNotRunningShort({ since: hint.since ? f.moment(hint.since) : t.unknown });
    case "providerOnly":
      return t.hintProviderOnlyShort({ provider: hint.provider, date: hint.lastSeenAt ? f.date(hint.lastSeenAt) : t.unknown });
    case "neverStarted":
      return hint.hasKey ? t.hintNeverStartedShort : t.hintNoKeyShort;
    case "keyRevoked":
      return t.hintKeyRevokedShort;
    case "errorRate":
      return t.hintErrorRateShort({ rate: f.percent(hint.rate) });
    case "failedDeliveries":
      return t.hintFailedDeliveriesShort({ count: hint.count });
    case "routeMissing":
      return t.hintRouteMissingShort({ prefix: hint.prefix });
    case "accessUnmanaged":
      return t.hintAccessUnmanagedShort;
    case "envStart":
      return t.hintEnvStartShort;
    case "rotation":
      return t.hintRotationShort;
    case "runtime":
      return t.hintRuntimeShort({ message: hint.message });
  }
}

const noteTone = (hint: AppHint): "neutral" | "warning" | "danger" =>
  hint.kind === "runtime" && hint.severity === "error" ? "danger" : HINT_PRESENTATION[hint.kind].tone;

// ── Level 1 ──────────────────────────────────────────────────────────────────

function AppList(props: { data: AppsViewData; t: AppsPageMessages }) {
  const t = props.t;
  const f = props.data.format;
  return (
    <div class="flex flex-col gap-1">
      <Show when={props.data.query.moved}>
        {(moved) => <MovedNotice text={moved() === "gateway" ? t.movedGateway : t.movedCredentials} closeLabel={t.closeHint} />}
      </Show>
      <Show
        when={props.data.list.state === "ok" && props.data.list}
        fallback={
          <Placeholder
            state="error"
            align="left"
            description={t.listFailed}
            action={
              <ButtonLink size="sm" variant="secondary" href={appsHref({ app: props.data.query.app })}>
                <i class="ti ti-refresh" aria-hidden="true" />
                {t.retry}
              </ButtonLink>
            }
          />
        }
      >
        {(list) => {
          const counts = countStatuses(list().apps);
          return (
            <>
              <Show when={list().issues.length > 0}>
                <NoticeCard tone="danger" icon="ti ti-alert-circle" class="mb-1">
                  <span>
                    <b>{t.rejected({ count: list().issues.length })}</b>{" "}
                    {list()
                      .issues.map((issue) => `${issue.key} – ${issue.reason}`)
                      .join(" · ")}
                    . {t.rejectedHint}
                  </span>
                  <Show when={list().logsHref}>
                    {(href) => (
                      <a class="mt-1 block underline" href={href()}>
                        {t.showLogs}
                      </a>
                    )}
                  </Show>
                </NoticeCard>
              </Show>
              <Show when={list().apps.length > 0} fallback={<Placeholder icon="ti ti-apps" description={t.empty} variant="compact" />}>
                <p class="px-2 pb-1 text-[13px] text-dimmed tabular-nums" data-apps-summary>
                  {t.summary({ total: list().apps.length, ...counts })}
                  <Show when={list().unchecked > 0}>
                    <span class="block">{t.unchecked({ count: list().unchecked })}</span>
                  </Show>
                </p>
                <nav aria-label={t.apps}>
                  <For each={list().apps}>
                    {(app) => {
                      const routes = routeSummary(app.routes);
                      const description = app.neverStarted
                        ? app.firstKnownAt
                          ? t.addedOn({ date: f.date(app.firstKnownAt) })
                          : t.statusIdle
                        : [app.release, app.routes.length ? `${routes.shown}${routes.more ? ` +${routes.more}` : ""}` : t.noRoutes]
                            .filter(Boolean)
                            .join(" · ");
                      const first = app.hints[0];
                      return (
                        <AppWorkspace.SidebarItem
                          variant="object"
                          href={appsHref({ app: app.id })}
                          active={props.data.query.app === app.id}
                          description={description}
                          note={
                            first
                              ? `${hintShort(t, f, first)}${app.hints.length > 1 ? ` · ${t.moreHints({ count: app.hints.length - 1 })}` : ""}`
                              : undefined
                          }
                          noteTone={first ? noteTone(first) : undefined}
                          meta={<Status t={t} status={app.status} />}
                          metaVisibility="always"
                          actions={
                            <AppWorkspace.SidebarItemActions visibility="hover">
                              <AppRowMenu
                                app={{ id: app.id, name: app.name }}
                                adminHref={app.adminHref}
                                logsHref={app.logsHref}
                                removable={app.removable}
                                neverStarted={app.neverStarted}
                              />
                            </AppWorkspace.SidebarItemActions>
                          }
                          data={{ app: app.id }}
                        >
                          <AppWorkspace.SidebarItemIcon>
                            <Tile icon={app.icon} accent={app.accent} />
                          </AppWorkspace.SidebarItemIcon>
                          <AppWorkspace.SidebarItemLabel>{app.name}</AppWorkspace.SidebarItemLabel>
                        </AppWorkspace.SidebarItem>
                      );
                    }}
                  </For>
                </nav>
              </Show>
            </>
          );
        }}
      </Show>
    </div>
  );
}

// ── Level 2 ──────────────────────────────────────────────────────────────────

/** One hint: its cause in words and exactly one way out. */
function Hint(props: { t: AppsPageMessages; f: AppsFormat; app: AppPageData; hint: AppHint }) {
  const t = props.t;
  const f = props.f;
  const entry = props.app.entry;
  const failedEvent = () =>
    props.app.details?.hears.find((hearing) => hearing.failedDeliveries.length > 0)?.title ??
    props.app.details?.hears.find((hearing) => hearing.counts.failed > 0)?.eventType ??
    null;
  /** `create` opens the keys column with the create dialog; `primary` marks the one filled action of the page. */
  const text = (): {
    lead: string;
    text: string;
    action: string;
    create?: boolean;
    primary?: boolean;
    docs?: string | null;
    docsLabel?: string;
  } => {
    const hint = props.hint;
    switch (hint.kind) {
      case "startRejected": {
        // The refusal stays until the next successful start, so its cause may already be gone in Core: a valid key
        // exists or background access is on again. Then only the deployment and a restart remain.
        const resolved =
          hint.reason === "disabled"
            ? entry.keys.accountStatus === "active"
            : hint.reason !== "connections_not_permitted" && entry.keys.active > 0;
        const lead = t.hintStartRejectedLead({ name: entry.name, live: entry.live });
        const text = t.hintStartRejectedText({ reason: hint.reason, when: f.relative(hint.at), resolved });
        const docs = { docs: props.app.docs.recover, docsLabel: t.docsWhatNow };
        if (resolved) return { lead, text, action: t.actKeysShow, ...docs };
        if (hint.reason === "disabled") return { lead, text, action: t.actReenable, primary: true };
        return { lead, text, action: t.actNewKey, create: true, primary: true, ...docs };
      }
      case "notRunning": {
        const since = hint.since ? f.moment(hint.since) : t.unknown;
        return { lead: t.hintNotRunningLead({ since }), text: t.hintNotRunningText({ name: entry.name }), action: t.actErrors };
      }
      case "providerOnly": {
        const date = hint.lastSeenAt ? f.date(hint.lastSeenAt) : t.unknown;
        return {
          lead: t.hintProviderOnlyLead({ provider: hint.provider }),
          text: t.hintProviderOnlyText({ provider: hint.provider, id: entry.id, date }),
          action: t.remove,
        };
      }
      case "neverStarted":
        return { lead: t.hintNeverStartedLead, text: t.hintNeverStartedText, action: hint.hasKey ? t.actKeysShow : t.actKeys };
      case "keyRevoked":
        return {
          lead: t.hintKeyRevokedLead,
          text: t.hintKeyRevokedText({ name: props.app.revokedKeyName ?? "" }),
          action: t.actNewKey,
          create: true,
          primary: true,
          docs: props.app.docs.recover,
          docsLabel: t.docsWhatNow,
        };
      case "envStart":
        return {
          lead: t.hintEnvStartLead,
          text: hint.hasKey ? t.hintEnvStartKeyText({ name: entry.name }) : t.hintEnvStartText({ name: entry.name }),
          action: hint.hasKey ? t.actKeysShow : t.actKeys,
          create: !hint.hasKey,
          docs: props.app.docs.migrate,
          docsLabel: t.docsMigration,
        };
      case "rotation":
        return { lead: t.hintRotationShort, text: "", action: t.actKeysShow };
      case "errorRate":
        return { lead: t.hintErrorRateLead({ rate: f.percent(hint.rate) }), text: t.hintErrorRateText, action: t.actErrors };
      case "failedDeliveries":
        return {
          lead: t.hintFailedDeliveriesLead({ count: hint.count }),
          text: t.hintFailedDeliveriesText({ name: entry.name, event: failedEvent() }),
          action: t.actEvents,
        };
      case "routeMissing":
        return {
          lead: t.hintRouteMissingLead({ prefix: hint.prefix }),
          text: t.hintRouteMissingText({ name: entry.name, owner: hint.owner }),
          action: t.actRoutes,
        };
      case "accessUnmanaged":
        return { lead: t.hintAccessUnmanagedLead, text: t.hintAccessUnmanagedText, action: t.actAccess };
      case "runtime":
        return { lead: hint.message, text: "", action: t.actRuntime };
    }
  };
  const presentation = () => HINT_PRESENTATION[props.hint.kind];
  return (
    <NoticeCard tone={noteTone(props.hint)} icon={presentation().icon} data-hint={props.hint.kind}>
      <span>
        <b>{text().lead}</b> {text().text}
      </span>
      <span class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Show
          when={presentation().target !== "remove"}
          fallback={<RemoveApp app={{ id: entry.id, name: entry.name }} variant="button" label={text().action} />}
        >
          <ButtonLink
            size="sm"
            variant={text().primary ? "primary" : "secondary"}
            href={appsHref({ app: entry.id, view: presentation().target as AppView, create: text().create })}
          >
            <Show when={text().create}>
              <i class="ti ti-plus" aria-hidden="true" />
            </Show>
            {text().action}
          </ButtonLink>
        </Show>
        <Show when={text().docs}>
          {(href) => (
            <a class="underline underline-offset-3" href={href()} target="_blank" rel="noopener noreferrer">
              {text().docsLabel}
            </a>
          )}
        </Show>
      </span>
    </NoticeCard>
  );
}

function GroupTitle(props: { children: string }) {
  return <p class="mt-3 mb-0.5 px-2 text-xs font-semibold text-dimmed first:mt-1">{props.children}</p>;
}

/** A row of the app page: label left, value right; it opens its column when it has one. */
function Row(props: {
  icon: string;
  label: string;
  value?: JSX.Element;
  view?: AppView | null;
  app: string;
  selected?: AppView | null;
  href?: string;
  external?: boolean;
  tone?: "danger";
  muted?: boolean;
}) {
  const href = () => props.href ?? (props.view ? appsHref({ app: props.app, view: props.view }) : undefined);
  return (
    <Show
      when={href()}
      fallback={
        // A fact without a column of its own: the same metrics as the rows around it, but no link and no hover.
        <div
          class="flex min-h-11 items-center gap-2.5 px-[0.5625rem] py-1.5 text-[13px] leading-[1.125rem]"
          classList={{ "text-dimmed": props.muted }}
          data-row={props.label}
        >
          <span class="inline-flex size-8 shrink-0 items-center justify-center text-base text-(--k2b-text-muted)" aria-hidden="true">
            <i class={props.icon} />
          </span>
          <span class="whitespace-nowrap text-[13px] font-semibold" classList={{ "font-normal": props.muted }}>
            {props.label}
          </span>
          <span class="min-w-0 flex-1 truncate text-right text-[13px] tabular-nums" classList={{ "text-dimmed": !props.muted }}>
            {props.value}
          </span>
          <span class="w-[1em] shrink-0" aria-hidden="true" />
        </div>
      }
    >
      {(link) => (
        // Object rows: the 44 px row group of the approved keys mockup, with a plain glyph instead of a tile.
        <AppWorkspace.SidebarItem
          variant="object"
          href={link()}
          active={Boolean(props.view) && props.selected === props.view}
          tone={props.tone}
          meta={
            <span class="flex items-center gap-2 text-[13px] font-normal text-(--k2b-text-muted) tabular-nums">
              {/* The value gives way before the label: it truncates, the label keeps its line. */}
              <span class="max-w-[12.5rem] truncate">{props.value}</span>
              <i class={`ti ${props.external ? "ti-arrow-up-right" : "ti-chevron-right"} text-dimmed`} aria-hidden="true" />
            </span>
          }
          metaVisibility="always"
          data={{ row: props.label }}
        >
          <AppWorkspace.SidebarItemIcon>
            <i class={`${props.icon} text-(--k2b-text-muted)`} />
          </AppWorkspace.SidebarItemIcon>
          <AppWorkspace.SidebarItemLabel>{props.label}</AppWorkspace.SidebarItemLabel>
        </AppWorkspace.SidebarItem>
      )}
    </Show>
  );
}

function AppOverview(props: { data: AppsViewData; app: AppPageData; t: AppsPageMessages }) {
  const t = props.t;
  const f = props.data.format;
  const entry = props.app.entry;
  const details = props.app.details;
  const selected = props.data.query.view;
  const neverStarted = entry.neverStarted;
  const providerOnly = !entry.coreKnows && !entry.live;
  const unavailable = props.app.providerFailures.length > 0 || entry.numbersUnavailable;
  const routes = routeSummary(entry.routes);
  const runtimeValue = () => {
    if (neverStarted) return "–";
    if (!entry.live)
      return providerOnly && entry.lastSeenAt
        ? t.lastSeenOn({ date: f.date(entry.lastSeenAt) })
        : `${entry.release ?? "–"} · ${t.instances({ count: 0 })}`;
    return (
      <>
        <b class="font-medium text-secondary">{entry.release ?? t.unknown}</b>
        {entry.instances !== null ? ` · ${t.instances({ count: entry.instances })}` : ""}
      </>
    );
  };
  const values = providerValues(t, f, entry.numbers, unavailable);
  const trafficValue = (): JSX.Element =>
    neverStarted ? (
      "–"
    ) : (
      <ProviderValue part="traffic" initial={values.traffic} unavailable={values.unavailable} unavailableLabel={t.unavailable} />
    );
  const errorsValue = (): JSX.Element =>
    neverStarted ? (
      "–"
    ) : (
      <ProviderValue
        part="errors"
        initial={values.errors}
        unavailable={values.unavailable}
        unavailableLabel={t.unavailable}
        tone={values.errorsTone}
      />
    );
  const accessValue = (): JSX.Element => {
    if (neverStarted) return t.removeOffNever;
    if (providerOnly) return "–";
    if (!entry.live && !entry.accessKind) return t.accessUnknown;
    if (entry.accessKind === "grants") {
      if (entry.access && entry.access.managers === 0) return <span class="text-(--k2b-warning-text)">{t.accessNobody}</span>;
      return entry.access ? t.accessValue({ people: entry.access.people, groups: entry.access.groups }) : t.unknown;
    }
    return entry.accessKind === "resources" ? t.accessResources : props.app.accessRule;
  };
  const domainsValue = (domains: readonly AppDomainEntry[] | "failed"): JSX.Element => {
    if (domains === "failed") return <span class="text-dimmed">{t.notLoaded}</span>;
    if (domains.length === 0) return t.domainsNone;
    const main = primaries(domains)[0]?.host ?? domains[0]!.host;
    const problems = domains.filter((domain) => domain.status && !domainHealthy(domain)).length;
    return (
      <>
        {main}
        {domains.length > 1 ? ` +${domains.length - 1}` : ""}
        <Show when={problems > 0}>
          {" · "}
          <span class="text-(--k2b-danger-text)">{t.domainsProblems({ count: problems })}</span>
        </Show>
      </>
    );
  };
  const keysValue = (): JSX.Element => {
    const keys = entry.keys;
    if (!entry.keysKnown) return <span class="text-dimmed">{t.notLoaded}</span>;
    if (keys.active > 0)
      return (
        <>
          <b class="font-medium text-secondary">{t.keysActive({ count: keys.active })}</b>
          {keys.active >= 2 ? ` · ${t.keysRotation}` : keys.lastUsedAt ? ` · ${t.keysUsed({ when: f.relative(keys.lastUsedAt) })}` : ""}
        </>
      );
    if (keys.revoked + keys.expired > 0) return <span class="text-(--k2b-danger-text)">{t.keysNoValid}</span>;
    return entry.live && entry.startsWithEnv !== false ? t.keysEnv : t.keysNone;
  };
  const eventsValue = (): JSX.Element => {
    if (neverStarted || providerOnly) return "–";
    if (!details) return <span class="text-dimmed">{t.notLoaded}</span>;
    const failed = details.hears.reduce((sum, hearing) => sum + hearing.counts.failed, 0);
    const waiting = details.hears.reduce((sum, hearing) => sum + hearing.counts.pending + hearing.counts.retrying, 0);
    return (
      <>
        {t.eventsValue({ hears: details.totals.hears, sends: details.totals.sends })}
        <Show when={failed > 0}>
          {" · "}
          <span class="text-(--k2b-danger-text)">{t.eventsFailed({ count: failed })}</span>
        </Show>
        <Show when={failed === 0 && waiting > 0 && !entry.live}>{` · ${t.eventsWaiting({ count: waiting })}`}</Show>
      </>
    );
  };
  const d = appDetailsMessages.resolve([props.data.locale]).t;
  const permissionLabels: Readonly<Record<string, string>> = {
    "mail:send": d.permissionMailSend,
    "mail:read": d.permissionMailRead,
    "resources:readers": d.permissionResourceReaders,
    "geo:query": d.permissionGeoQuery,
  };
  const services = () => {
    if (neverStarted || providerOnly) return "–";
    if (!details) return <span class="text-dimmed">{t.notLoaded}</span>;
    const labels = details.access.platformPermissions.map((permission) => permissionLabels[permission] ?? permission);
    return labels.length ? labels.join(", ") : t.none;
  };
  // Routes and capabilities have their place in the columns; the rest of the providers' links sit under "More".
  const links = entry.numbers.flatMap((item) => item.links).filter((link) => link.kind !== "routes" && link.kind !== "capabilities");
  return (
    <div class="flex flex-col pb-6">
      <Show when={entry.hints.some((hint) => hint.kind !== "rotation") || props.app.providerFailures.length > 0 || !details}>
        <div class="mb-2 flex flex-col gap-1.5" data-app-hints>
          <For each={entry.hints.filter((hint) => hint.kind !== "rotation")}>
            {(hint) => <Hint t={t} f={f} app={props.app} hint={hint} />}
          </For>
          <For each={props.app.providerFailures}>
            {(provider) => (
              <NoticeCard tone="neutral" icon="ti ti-cloud-off" data-hint="provider">
                <span>
                  <b>{t.providerDownLead({ provider })}</b> {t.providerDownText}
                </span>
                <span class="mt-1.5 block">
                  <ProviderRetry app={entry.id} label={t.retry} />
                </span>
              </NoticeCard>
            )}
          </For>
          <Show when={!details && !neverStarted && !providerOnly}>
            <NoticeCard tone="danger" icon="ti ti-alert-circle" data-hint="details">
              <span>
                <b>{t.detailsFailedLead}</b> {t.detailsFailedText}
              </span>
              <span class="mt-1.5 block">
                <ButtonLink size="sm" variant="secondary" href={appsHref({ app: entry.id, view: selected })}>
                  <i class="ti ti-refresh" aria-hidden="true" />
                  {t.reload}
                </ButtonLink>
              </span>
            </NoticeCard>
          </Show>
        </div>
      </Show>
      <GroupTitle>{t.groupState}</GroupTitle>
      <Row
        icon="ti ti-server-2"
        label={t.runtime}
        value={runtimeValue()}
        view={neverStarted ? null : "runtime"}
        app={entry.id}
        selected={selected}
      />
      <Row
        icon="ti ti-route"
        label={t.routes}
        value={entry.routes.length ? `${routes.shown}${routes.more ? ` +${routes.more}` : ""}` : "–"}
        view={neverStarted ? null : "routes"}
        app={entry.id}
        selected={selected}
      />
      <Row icon="ti ti-chart-line" label={t.traffic} value={trafficValue()} view={neverStarted ? null : "routes"} app={entry.id} />
      <Row
        icon="ti ti-alert-triangle"
        label={t.errors}
        value={errorsValue()}
        view={neverStarted || providerOnly ? null : "errors"}
        app={entry.id}
        selected={selected}
      />
      <GroupTitle>{t.groupOverview}</GroupTitle>
      <Row
        icon="ti ti-lock"
        label={t.access}
        value={accessValue()}
        view={neverStarted || providerOnly ? null : "access"}
        app={entry.id}
        selected={selected}
      />
      <Row
        icon="ti ti-key"
        label={t.keys}
        value={props.app.keysSupported ? keysValue() : "–"}
        view={providerOnly || !props.app.keysSupported ? null : "keys"}
        app={entry.id}
        selected={selected}
      />
      <Show when={props.app.domains}>
        {(domains) => (
          <Row icon="ti ti-world" label={t.domains} value={domainsValue(domains())} view="domains" app={entry.id} selected={selected} />
        )}
      </Show>
      <Row
        icon="ti ti-broadcast"
        label={t.events}
        value={eventsValue()}
        view={neverStarted || providerOnly || !details ? null : "events"}
        app={entry.id}
        selected={selected}
      />
      <Row
        icon="ti ti-bell"
        label={t.notifications}
        value={
          neverStarted || providerOnly ? (
            "–"
          ) : details ? (
            t.kinds({ count: details.totals.notifications })
          ) : (
            <span class="text-dimmed">{t.notLoaded}</span>
          )
        }
        app={entry.id}
      />
      <Row icon="ti ti-plug-connected" label={t.platformServices} value={services()} app={entry.id} />
      <GroupTitle>{t.groupMore}</GroupTitle>
      <Show when={entry.adminHref}>
        {(href) => <Row icon="ti ti-settings" label={t.adminOf({ name: entry.name })} href={href()} external app={entry.id} />}
      </Show>
      <For each={links}>
        {(link) => (
          <Row
            icon={LINK_ICON[link.kind ?? "other"] ?? "ti ti-external-link"}
            label={link.label}
            href={link.href}
            external
            app={entry.id}
          />
        )}
      </For>
      <Show
        when={entry.removable && !neverStarted}
        fallback={
          <Row icon="ti ti-trash" label={t.removeOff} value={neverStarted ? t.removeOffNever : t.removeOffValue} app={entry.id} muted />
        }
      >
        <RemoveApp app={{ id: entry.id, name: entry.name }} variant="row" label={t.remove} />
      </Show>
    </div>
  );
}

// ── Level 3 ──────────────────────────────────────────────────────────────────

function Section(props: { title: string; count?: number; children?: JSX.Element }) {
  return (
    <p class="mt-4 mb-1 flex items-baseline gap-1.5 px-2 text-xs font-semibold text-dimmed first:mt-1">
      {props.title}
      <Show when={props.count !== undefined}>
        <span class="font-normal">{props.count}</span>
      </Show>
      {props.children}
    </p>
  );
}

function Source(props: { children: string }) {
  return <p class="mt-1 px-2 text-[11.5px] text-(--k2b-text-placeholder)">{props.children}</p>;
}

function FootLinks(props: { links: ReadonlyArray<{ label: string; href: string }> }) {
  return (
    <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 px-2 text-[13.5px]">
      <For each={props.links}>
        {(link) => (
          <a href={link.href} class="inline-flex items-center gap-1 underline underline-offset-3">
            {link.label}
            <i class="ti ti-arrow-up-right text-[14px] text-dimmed" aria-hidden="true" />
          </a>
        )}
      </For>
    </div>
  );
}

function AccessColumn(props: { t: AppsPageMessages; detail: Extract<DetailData, { view: "access" }>; name: string; unmanaged: boolean }) {
  const t = props.t;
  return (
    <Show
      when={props.detail.editor}
      fallback={<p class="px-2 py-1 text-[13.5px] text-secondary">{t.fixedRule({ rule: props.detail.rule })}</p>}
    >
      {(editor) => (
        <div class="flex flex-col gap-2">
          <NoticeCard tone="neutral" icon="ti ti-shield-check">
            {t.accessAdmin}
          </NoticeCard>
          <Show when={props.unmanaged}>
            <NoticeCard tone="warning" icon="ti ti-lock-exclamation">
              <span>
                <b>{t.hintAccessUnmanagedLead}</b> {t.hintAccessUnmanagedText}
              </span>
            </NoticeCard>
          </Show>
          <Access {...editor()} />
        </div>
      )}
    </Show>
  );
}

const SHOWN = 3;

function EventsColumn(props: { t: AppsPageMessages; f: AppsFormat; app: AppPageData; locale: string }) {
  const t = props.t;
  const d = appDetailsMessages.resolve([props.locale]).t;
  const details = props.app.details!;
  const time = (value: string | null) => (value ? props.f.dateTime(value) : "");
  return (
    <div class="flex flex-col">
      <Section title={d.hears} count={details.totals.hears} />
      <Show when={details.hears.length > 0} fallback={<p class="px-2 text-[13.5px] text-dimmed">{t.none}</p>}>
        <ExpandList
          items={details.hears}
          total={details.totals.hears}
          more={(count) => t.showAll({ count })}
          moreHint={details.totals.hears > details.hears.length ? `cld events subscriptions --app ${props.app.entry.id}` : null}
          render={(hearing) => (
            <div class="rounded-lg px-2 py-2 hover:bg-(--k2b-hover)" data-hearing={hearing.eventType}>
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                {hearing.title ?? hearing.eventType}
                <Show when={hearing.counts.failed > 0}>
                  <StatusBadge tone="error" icon={null} label={t.eventsFailed({ count: hearing.counts.failed })} />
                </Show>
                <Show when={hearing.isNew}>
                  <StatusBadge tone="info" icon={null} label={d.new} />
                </Show>
                <Show when={hearing.state !== "active"}>
                  <StatusBadge
                    tone={hearing.state === "blocked" ? "warning" : "neutral"}
                    label={hearing.state === "blocked" ? d.blocked : d.cancelled}
                  />
                </Show>
              </div>
              <div class="mt-0.5 text-[12.5px] text-dimmed">
                <code class="font-mono text-[12px]">{`${hearing.eventType} v${hearing.version}`}</code>
                {` · ${d.from({ app: props.app.appNames.get(hearing.publisherAppId) ?? hearing.publisherAppId })}`}
                {hearing.counts.done ? ` · ${d.delivered({ count: hearing.counts.done })}` : ""}
              </div>
              <Show when={hearing.failedDeliveries.length > 0}>
                <div class="mt-1 ml-3 flex flex-col gap-1">
                  <For each={hearing.failedDeliveries}>
                    {(delivery) => (
                      <div class="rounded-lg px-2 py-1.5">
                        <div class="flex flex-wrap items-center gap-2 text-[13px]">
                          <StatusBadge tone="error" icon={null} label={d.failedState} />
                          <span class="font-mono text-[12px] text-dimmed">
                            {[delivery.code, time(delivery.lastAttemptAt), d.attempts({ count: delivery.attempts })]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </div>
                        <Show when={hearing.state === "active"}>
                          <div class="mt-1.5">
                            <Redeliver
                              id={delivery.id}
                              label={d.redeliverLabel({ event: hearing.title ?? hearing.eventType, time: time(delivery.lastAttemptAt) })}
                            />
                          </div>
                        </Show>
                        <Show when={delivery.lastError}>
                          <p class="mt-1 text-[12.5px] break-words text-secondary">{delivery.lastError}</p>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )}
        />
      </Show>
      <Section title={d.sends} count={details.totals.sends} />
      <Show when={details.sends.length > 0} fallback={<p class="px-2 text-[13.5px] text-dimmed">{t.none}</p>}>
        <ExpandList
          items={details.sends}
          total={details.totals.sends}
          more={(count) => t.showAll({ count })}
          moreHint={null}
          render={(event) => (
            <div class="rounded-lg px-2 py-2 hover:bg-(--k2b-hover)">
              <div class="flex flex-wrap items-center gap-2 text-sm font-medium">
                {event.title}
                <Show when={event.place}>
                  <StatusBadge tone="neutral" icon={null} label={d.resourceEvent} />
                </Show>
              </div>
              <div class="mt-0.5 text-[12.5px] text-dimmed">
                <code class="font-mono text-[12px]">{`${event.type} v${event.version}`}</code>
                {` · ${d.subscribers({ count: event.subscriberCount })}`}
              </div>
            </div>
          )}
        />
      </Show>
      <Section title={t.notifications} count={details.totals.notifications} />
      <Show when={details.notifications.length > 0} fallback={<p class="px-2 text-[13.5px] text-dimmed">{t.none}</p>}>
        <ExpandList
          items={details.notifications}
          total={details.totals.notifications}
          more={(count) => t.showAll({ count })}
          moreHint={null}
          render={(notification) => (
            <div class="rounded-lg px-2 py-2 hover:bg-(--k2b-hover)">
              <div class="text-sm font-medium">{notification.label}</div>
              <div class="mt-0.5 text-[12.5px] text-dimmed">
                {[
                  notification.requiredChannels.length ? d.required({ channels: notification.requiredChannels.join(", ") }) : null,
                  notification.recommendedChannels.length ? d.recommended({ channels: notification.recommendedChannels.join(", ") }) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          )}
        />
      </Show>
    </div>
  );
}

/** The first three entries, the rest behind "Show all n"; past the list limit, the CLI hint. */
function ExpandList<T>(props: {
  items: readonly T[];
  total: number;
  more: (count: number) => string;
  moreHint: string | null;
  render: (item: T) => JSX.Element;
}) {
  return (
    <div class="flex flex-col">
      <For each={props.items.slice(0, SHOWN)}>{(item) => props.render(item)}</For>
      <Show when={props.items.length > SHOWN}>
        <details class="group">
          <summary class="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 py-2 text-[13px] text-dimmed hover:bg-(--k2b-hover) group-open:hidden">
            <i class="ti ti-chevron-down" aria-hidden="true" />
            {props.more(props.total)}
          </summary>
          <For each={props.items.slice(SHOWN)}>{(item) => props.render(item)}</For>
          <Show when={props.moreHint}>
            {(hint) => (
              <p class="px-2 py-1 text-[12.5px] text-dimmed">
                <code>{hint()}</code>
              </p>
            )}
          </Show>
        </details>
      </Show>
    </div>
  );
}

function RoutesColumn(props: { t: AppsPageMessages; f: AppsFormat; detail: Extract<DetailData, { view: "routes" }>; app: AppEntry }) {
  const t = props.t;
  const f = props.f;
  const misrouted = () => (props.detail.tables[0]?.rows ?? []).filter((row) => row.router === "missing");
  return (
    <div class="flex flex-col gap-2">
      <ViewTabs
        label={t.window}
        current={props.detail.window}
        items={WINDOWS.map((window) => ({
          id: window,
          label: t.windowLabel({ window }),
          href: appsHref({ app: props.app.id, view: "routes", window }),
        }))}
      />
      <For each={props.detail.failures}>
        {(provider) => (
          <NoticeCard tone="neutral" icon="ti ti-cloud-off">
            <span>{t.providerDownRoutes({ provider })}</span>
            <span class="mt-1.5 block">
              <ButtonLink size="sm" variant="secondary" href={appsHref({ app: props.app.id, view: "routes", window: props.detail.window })}>
                <i class="ti ti-refresh" aria-hidden="true" />
                {t.retry}
              </ButtonLink>
            </span>
          </NoticeCard>
        )}
      </For>
      <Show when={!props.detail.routerKnown}>
        <NoticeCard tone="neutral" icon="ti ti-help-circle">
          <span>
            <b>{t.routerUnknownHintLead}</b> {t.routerUnknownHintText}
          </span>
        </NoticeCard>
      </Show>
      <For each={misrouted()}>
        {(row) => (
          <NoticeCard tone="warning" icon="ti ti-route-off">
            {row.owner
              ? t.routeOwnerHint({ prefix: row.prefix, name: props.app.name, owner: row.owner })
              : t.hintRouteMissingText({ name: props.app.name, owner: null })}
          </NoticeCard>
        )}
      </For>
      <For each={props.detail.tables}>
        {(table) => (
          <>
            <table class="w-full table-fixed border-collapse text-[13.5px]" data-routes-table>
              <colgroup>
                <col style={{ width: "34%" }} />
                <col style={{ width: "22%" }} />
                <col style={{ width: "16%" }} />
                <col />
              </colgroup>
              <thead>
                <tr class="text-left text-xs font-semibold text-dimmed">
                  <th class="px-2 py-1.5">{t.route}</th>
                  <th class="px-2 py-1.5 text-right">{t.requests}</th>
                  <th class="px-2 py-1.5 text-right">{t.errors}</th>
                  <th class="px-2 py-1.5 max-sm:hidden">{t.router}</th>
                </tr>
              </thead>
              <tbody>
                <For each={table.rows}>
                  {(row) => {
                    const absent = table.provider === null || row.router === "missing" || row.requests === null;
                    return (
                      <tr class="h-10 hover:bg-(--k2b-hover)" data-route={row.prefix}>
                        <td
                          class="truncate px-2 font-mono text-[12.5px]"
                          classList={{ "text-(--k2b-danger-text)": row.router === "missing" }}
                        >
                          {row.prefix}
                        </td>
                        <td class="px-2 text-right tabular-nums text-secondary">{absent ? "–" : f.number(row.requests!)}</td>
                        <td
                          class="px-2 text-right tabular-nums text-secondary"
                          classList={{
                            "text-(--k2b-danger-text)":
                              !absent && (row.errors ?? 0) > 0 && (row.errors ?? 0) / Math.max(1, row.requests ?? 1) >= 0.01,
                          }}
                        >
                          {absent || row.errors === null ? "–" : f.number(row.errors)}
                        </td>
                        <td class="px-2 max-sm:hidden">
                          {row.router === "missing" ? (
                            <StatusBadge tone="error" icon={null} label={t.routerMissing} />
                          ) : row.router === "unknown" ? (
                            <span class="text-xs text-dimmed">{t.routerUnknown}</span>
                          ) : (
                            <StatusBadge tone="ok" variant="dot" label={t.routerActive} />
                          )}
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
            <Source>{t.numbersFrom({ providers: table.provider ?? "–" })}</Source>
          </>
        )}
      </For>
      <FootLinks
        links={[
          ...(props.detail.telemetryHref ? [{ label: t.openTelemetry, href: props.detail.telemetryHref }] : []),
          ...(props.detail.routesHref ? [{ label: t.allRoutes, href: props.detail.routesHref }] : []),
        ]}
      />
    </div>
  );
}

function RuntimeColumn(props: { t: AppsPageMessages; f: AppsFormat; detail: Extract<DetailData, { view: "runtime" }>; app: AppEntry }) {
  const t = props.t;
  const f = props.f;
  const d = props.detail;
  const kv = (label: string, value: JSX.Element) => (
    <>
      <dt class="text-dimmed">{label}</dt>
      <dd class="m-0 min-w-0 [overflow-wrap:anywhere]">{value}</dd>
    </>
  );
  return (
    <div class="flex flex-col gap-2">
      <For each={d.issues}>
        {(issue) => (
          <NoticeCard tone={issue.severity === "error" ? "danger" : "warning"} icon="ti ti-alert-triangle">
            {issue.message}
          </NoticeCard>
        )}
      </For>
      <dl class="mx-2 my-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13.5px]">
        {kv(t.state, <Status t={t} status={props.app.status} />)}
        {kv(t.version, d.release ?? t.unknown)}
        {kv(t.build, d.build ? <span class="font-mono text-[12.5px]">{d.build}</span> : t.unknown)}
        {kv(t.sync, d.sync ?? t.unknown)}
        {kv(t.baseUrl, d.baseUrl ? <span class="font-mono text-[12.5px]">{d.baseUrl}</span> : t.unknown)}
        {kv(t.heartbeat, d.heartbeatAt ? f.relative(d.heartbeatAt) : t.unknown)}
        {kv(t.runningSince, d.startedAt ? `${f.relative(d.startedAt)} · ${f.dateTime(d.startedAt)}` : t.unknown)}
      </dl>
      <Section title={t.instancesTitle} count={d.instances.length} />
      <Show when={d.instances.length > 0} fallback={<p class="px-2 text-[13.5px] text-dimmed">{t.none}</p>}>
        <For each={d.instances}>
          {(instance) => (
            <div class="rounded-lg px-2 py-1.5 hover:bg-(--k2b-hover)">
              <div class="font-mono text-sm font-medium">{instance.hostname}</div>
              <div class="mt-0.5 text-[12.5px] text-dimmed">
                {t.startedAt({ time: f.dateTime(instance.startedAt) })} ·{" "}
                {instance.via === "key"
                  ? instance.keyName
                    ? t.viaKey({ key: instance.keyName })
                    : t.viaKeyUnknown
                  : instance.via === "env"
                    ? t.viaEnv
                    : t.viaUnknown}
              </div>
            </div>
          )}
        </For>
      </Show>
      <Section title={t.integration} />
      <dl class="mx-2 my-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13.5px]">
        {kv(
          t.navigation,
          d.inRail ? (
            <span>
              <i class="ti ti-check text-(--k2b-success-text)" aria-hidden="true" /> {t.inRail}
            </span>
          ) : (
            <span class="text-dimmed">
              <i class="ti ti-minus" aria-hidden="true" /> {t.noneShort}
            </span>
          ),
        )}
        {kv(
          t.administration,
          d.adminHref ? (
            <a class="underline underline-offset-3" href={d.adminHref}>
              {t.adminOf({ name: props.app.name })}
            </a>
          ) : (
            <span class="text-dimmed">
              <i class="ti ti-minus" aria-hidden="true" /> {t.noneShort}
            </span>
          ),
        )}
        {kv(
          t.capabilities,
          d.capabilities ? (
            <span>
              <i class="ti ti-check text-(--k2b-success-text)" aria-hidden="true" /> {d.capabilities} {t.offered}
              {d.capabilitiesHref ? (
                <>
                  {" · "}
                  <a class="underline underline-offset-3" href={d.capabilitiesHref}>
                    {t.showCapabilities}
                  </a>
                </>
              ) : null}
            </span>
          ) : (
            <span class="text-dimmed">
              <i class="ti ti-minus" aria-hidden="true" /> {t.noneShort}
            </span>
          ),
        )}
      </dl>
    </div>
  );
}

function ErrorsColumn(props: { t: AppsPageMessages; f: AppsFormat; detail: Extract<DetailData, { view: "errors" }>; app: AppPageData }) {
  const t = props.t;
  const f = props.f;
  const d = props.detail;
  const deliveries = () => props.app.details?.hears.reduce((sum, hearing) => sum + hearing.counts.failed, 0) ?? 0;
  return (
    <div class="flex flex-col">
      <Show when={deliveries() > 0}>
        <div class="rounded-lg px-2 py-2">
          <div class="flex items-center gap-2 text-[13.5px] font-medium">
            <StatusBadge tone="error" icon={null} label={String(deliveries())} />
            {t.deliveriesFailed}
          </div>
          <div class="mt-1.5">
            <ButtonLink size="sm" variant="secondary" href={appsHref({ app: props.app.entry.id, view: "events" })}>
              {t.showEvents}
            </ButtonLink>
          </div>
        </div>
      </Show>
      <For each={d.failures}>
        {(provider) => (
          <NoticeCard tone="neutral" icon="ti ti-cloud-off" class="mb-2">
            <span>{t.providerDownRoutes({ provider })}</span>
          </NoticeCard>
        )}
      </For>
      <Show when={d.groups.length === 0 && d.failures.length > 0}>
        <p class="px-2 py-1 text-[13.5px] text-dimmed">{t.unavailable}</p>
      </Show>
      <For each={d.groups}>
        {(group) => {
          const total = group.total ?? group.failedRequests.length;
          return (
            <>
              <Show when={deliveries() > 0 || d.groups.length > 1}>
                <Section title={t.failedRequests} count={total} />
              </Show>
              <Show
                when={group.failedRequests.length > 0}
                fallback={<p class="px-2 py-1 text-[13.5px] text-dimmed">{t.noFailedRequests}</p>}
              >
                <ExpandList
                  items={group.failedRequests}
                  total={total}
                  more={(count) => t.showAll({ count })}
                  moreHint={null}
                  render={(request) => (
                    <div class="rounded-lg px-2 py-2 hover:bg-(--k2b-hover)">
                      <div class="flex items-center gap-2 text-[13.5px]">
                        <StatusBadge tone="error" icon={null} label={String(request.status)} />
                        <span class="truncate font-mono text-[13px]">{`${request.method} ${request.path}`}</span>
                      </div>
                      <div class="mt-0.5 text-[12.5px] text-dimmed">{f.dateTime(request.at)}</div>
                    </div>
                  )}
                />
                <Show when={total > group.failedRequests.length && d.telemetryHref}>
                  {(href) => (
                    <p class="px-2 py-1 text-[13px] text-dimmed">
                      {t.moreInTelemetry({ count: total - group.failedRequests.length })}{" "}
                      <a class="underline underline-offset-3" href={href()}>
                        {t.openTelemetry}
                      </a>
                    </p>
                  )}
                </Show>
              </Show>
              <Source>{t.errorsSource({ providers: group.provider })}</Source>
            </>
          );
        }}
      </For>
      <FootLinks
        links={[
          ...(d.telemetryHref ? [{ label: t.openTelemetry, href: d.telemetryHref }] : []),
          ...(d.logsHref ? [{ label: t.logs, href: d.logsHref }] : []),
        ]}
      />
    </div>
  );
}

const detailTitle = (t: AppsPageMessages, view: AppView, name: string) =>
  ({
    access: t.titleAccess({ name }),
    keys: t.titleKeys,
    domains: t.titleDomains,
    events: t.titleEvents,
    routes: t.titleRoutes,
    runtime: t.titleRuntime,
    errors: t.titleErrors,
  })[view];

// ── The page ─────────────────────────────────────────────────────────────────

export function AppsView(props: { data: AppsViewData }) {
  const t = appsPageMessages.resolve([props.data.locale]).t;
  const data = props.data;
  const app = data.app;
  const detail = data.detail;
  const level = detail ? "detail" : app ? "app" : "apps";
  const known = data.list.state === "ok" ? data.list.apps.map((entry) => ({ id: entry.id, name: entry.name })) : [];
  return (
    <AppWorkspace.Main level={level}>
      <AppWorkspace.MainPane
        id="apps"
        label={t.apps}
        href="/admin/apps"
        defaultSize={328}
        minSize={280}
        maxSize={420}
        actions={<AddApp known={known} />}
      >
        <AppList data={data} t={t} />
      </AppWorkspace.MainPane>
      {app ? (
        <AppWorkspace.MainPane
          id="app"
          label={app.entry.name}
          lead={<Tile icon={app.entry.icon} accent={app.entry.accent} />}
          description={app.entry.description || undefined}
          actions={<Status t={t} status={app.entry.status} />}
          href={appsHref({ app: app.entry.id })}
          defaultSize={384}
          minSize={320}
          maxSize={480}
        >
          <AppOverview data={data} app={app} t={t} />
        </AppWorkspace.MainPane>
      ) : null}
      {app && detail ? (
        (() => {
          const open = () => ({ app, detail });
          const view = detail.view as AppView;
          const name = app.entry.name;
          const columnData = detail;
          return (
            <AppWorkspace.MainPane
              id="detail"
              label={detailTitle(t, view, name)}
              actions={
                columnData.view === "keys" ? (
                  <KeysCreate
                    app={columnData.keys.app}
                    active={(columnData.keys.initialKeys ?? []).filter((key) => key.status === "active").length}
                    disabledAccount={columnData.keys.accountStatus === "disabled"}
                    neverStarted={columnData.keys.neverStarted}
                  />
                ) : columnData.view === "domains" ? (
                  <DomainsAdd app={columnData.domains.app} initial={columnData.domains.initial ?? []} />
                ) : undefined
              }
              description={
                view === "routes" && columnData.view === "routes" && columnData.avgMs !== null
                  ? t.avgLatency({ ms: data.format.ms(columnData.avgMs) })
                  : view === "errors"
                    ? t.errorsSub
                    : undefined
              }
            >
              <div class="pb-6" data-detail={view}>
                {/* The column's sentence may wrap, so it stays in the body instead of the one-line level head. */}
                {(() => {
                  const sentence =
                    columnData.view === "keys" ? (
                      <>
                        {keysMessages.resolve([data.locale]).t.sentence}{" "}
                        {columnData.keys.docsHref ? (
                          <a class="underline underline-offset-3" href={columnData.keys.docsHref}>
                            {keysMessages.resolve([data.locale]).t.howItWorks}
                          </a>
                        ) : null}
                      </>
                    ) : columnData.view === "domains" ? (
                      domainsMessages.resolve([data.locale]).t.sentence
                    ) : columnData.view === "events" ? (
                      t.eventsSub({ name })
                    ) : columnData.view === "access" && columnData.editor ? (
                      t.accessSub({ name })
                    ) : null;
                  return sentence ? <p class="mb-3 max-w-[40rem] px-2 text-[13px] text-dimmed">{sentence}</p> : null;
                })()}
                {columnData.view === "access" ? (
                  <AccessColumn
                    t={t}
                    detail={columnData}
                    name={name}
                    unmanaged={open().app.entry.hints.some((hint) => hint.kind === "accessUnmanaged")}
                  />
                ) : columnData.view === "keys" ? (
                  <Keys {...columnData.keys} />
                ) : columnData.view === "domains" ? (
                  <Domains {...columnData.domains} />
                ) : columnData.view === "events" ? (
                  <EventsColumn t={t} f={data.format} app={open().app} locale={data.locale} />
                ) : columnData.view === "routes" ? (
                  <RoutesColumn t={t} f={data.format} detail={columnData} app={open().app.entry} />
                ) : columnData.view === "runtime" ? (
                  <RuntimeColumn t={t} f={data.format} detail={columnData} app={open().app.entry} />
                ) : (
                  <ErrorsColumn t={t} f={data.format} detail={columnData} app={open().app} />
                )}
              </div>
            </AppWorkspace.MainPane>
          );
        })()
      ) : (
        <AppWorkspace.MainPane id="fill" label="">
          {app ? null : <p class="mt-10 px-4 text-center text-[13.5px] text-dimmed">{t.pick}</p>}
        </AppWorkspace.MainPane>
      )}
    </AppWorkspace.Main>
  );
}
