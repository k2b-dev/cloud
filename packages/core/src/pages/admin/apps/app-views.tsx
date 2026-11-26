import { Bar, Button, Chip, Facts, Notice, Row, Section, Table, Tabs, Text } from "@k2b/ui/v2";
import { For, type JSX, Show } from "solid-js";
import { domainHealthy, primaries } from "./domains-model";
import { type AppsFormat, providerValues } from "./format";
import { hintWords, noteTone } from "./hints";
import { appDetailsMessages } from "./messages";
import {
  type AppHint,
  type AppStatusKind,
  type AppsListState,
  type AppView,
  appsHref,
  HINT_PRESENTATION,
  routeSummary,
  WINDOWS,
} from "./model";
import type { AppsPageMessages } from "./page-messages";
import { openRemoveDialog } from "./remove-dialog";
import type { AppPageData, DetailData } from "./view-data";

type Ctx = { t: AppsPageMessages; f: AppsFormat; locale: string; list: AppsListState };

export const STATUS: Record<AppStatusKind, "ok" | "warn" | "bad" | undefined> = { ok: "ok", warn: "warn", error: "bad", idle: undefined };
export const statusLabel = (t: AppsPageMessages, status: AppStatusKind) =>
  ({ ok: t.statusOk, warn: t.statusWarn, error: t.statusError, idle: t.statusIdle })[status];

/** The app's state as a chip with its word; idle is a plain chip. */
export const StatusChip = (props: { t: AppsPageMessages; status: AppStatusKind }) => (
  <Show when={STATUS[props.status]} fallback={<Chip>{statusLabel(props.t, props.status)}</Chip>}>
    {(tone) => <Chip status={tone()}>{statusLabel(props.t, props.status)}</Chip>}
  </Show>
);

const NOTICE_TONE = { neutral: "note", warning: "warn", danger: "bad" } as const;

/** One hint: its cause in words and exactly one way out. */
const Hint = (props: Ctx & { app: AppPageData; hint: AppHint }) => {
  const words = () => hintWords(props.t, props.f, props.app, props.hint);
  const entry = props.app.entry;
  const way = () =>
    words().target === "remove"
      ? { label: words().action, icon: "trash", onClick: () => void openRemoveDialog({ id: entry.id, name: entry.name }, props.locale) }
      : {
          label: words().action,
          icon: words().create ? "plus" : undefined,
          href: appsHref({ app: entry.id, view: words().target as AppView, create: words().create, list: props.list }),
        };
  return (
    <Notice
      tone={NOTICE_TONE[noteTone(props.hint)]}
      icon={HINT_PRESENTATION[props.hint.kind].icon.replace(/^ti\s+ti-/, "")}
      title={words().lead}
      actions={words().docs ? [way(), { label: words().docsLabel ?? "", href: words().docs ?? undefined }] : [way()]}
    >
      {words().text}
    </Notice>
  );
};

/** One fact of the app as a row; a fact with its own view opens it. */
type Fact = { label: string; value: string; view?: AppView | null; href?: string };
const FactRows = (props: Ctx & { app: string; title: string; icon: string; facts: readonly (Fact | false | null | undefined)[] }) => (
  <Section icon={props.icon} title={props.title}>
    <For each={props.facts.filter((fact): fact is Fact => Boolean(fact))}>
      {(fact) => (
        <Row
          lines={[fact.value, fact.label]}
          href={fact.href ?? (fact.view ? appsHref({ app: props.app, view: fact.view, list: props.list }) : undefined)}
        />
      )}
    </For>
  </Section>
);

/** The app's page: what needs doing first, then its state, its connections and more. */
export function AppOverview(props: Ctx & { app: AppPageData }) {
  const t = props.t;
  const f = props.f;
  const entry = props.app.entry;
  const details = props.app.details;
  const neverStarted = entry.neverStarted;
  const providerOnly = !entry.coreKnows && !entry.live;
  const unavailable = props.app.providerFailures.length > 0 || entry.numbersUnavailable;
  const routes = routeSummary(entry.routes);
  const values = providerValues(t, f, entry.numbers, unavailable);
  const runtime = () => {
    if (neverStarted) return "–";
    if (!entry.live)
      return providerOnly && entry.lastSeenAt
        ? t.lastSeenOn({ date: f.date(entry.lastSeenAt) })
        : `${entry.release ?? "–"} · ${t.instances({ count: 0 })}`;
    return `${entry.release ?? t.unknown}${entry.instances !== null ? ` · ${t.instances({ count: entry.instances })}` : ""}`;
  };
  const access = () => {
    if (neverStarted) return t.removeOffNever;
    if (providerOnly) return "–";
    if (!entry.live && !entry.accessKind) return t.accessUnknown;
    if (entry.accessKind === "grants") {
      if (entry.access && entry.access.managers === 0) return t.accessNobody;
      return entry.access ? t.accessValue({ people: entry.access.people, groups: entry.access.groups }) : t.unknown;
    }
    return entry.accessKind === "resources" ? t.accessResources : props.app.accessRule;
  };
  const domains = () => {
    const list = props.app.domains;
    if (!list) return null;
    if (list === "failed") return t.notLoaded;
    if (list.length === 0) return t.domainsNone;
    const main = primaries(list)[0]?.host ?? list[0]!.host;
    const problems = list.filter((domain) => domain.status && !domainHealthy(domain)).length;
    return `${main}${list.length > 1 ? ` +${list.length - 1}` : ""}${problems > 0 ? ` · ${t.domainsProblems({ count: problems })}` : ""}`;
  };
  const keys = () => {
    const k = entry.keys;
    if (!entry.keysKnown) return t.notLoaded;
    if (k.active > 0)
      return `${t.keysActive({ count: k.active })}${k.active >= 2 ? ` · ${t.keysRotation}` : k.lastUsedAt ? ` · ${t.keysUsed({ when: f.relative(k.lastUsedAt) })}` : ""}`;
    if (k.revoked + k.expired > 0) return t.keysNoValid;
    return entry.live && entry.startsWithEnv !== false ? t.keysEnv : t.keysNone;
  };
  const events = () => {
    if (neverStarted || providerOnly) return "–";
    if (!details) return t.notLoaded;
    const failed = details.hears.reduce((sum, hearing) => sum + hearing.counts.failed, 0);
    const waiting = details.hears.reduce((sum, hearing) => sum + hearing.counts.pending + hearing.counts.retrying, 0);
    return `${t.eventsValue({ hears: details.totals.hears, sends: details.totals.sends })}${failed > 0 ? ` · ${t.eventsFailed({ count: failed })}` : failed === 0 && waiting > 0 && !entry.live ? ` · ${t.eventsWaiting({ count: waiting })}` : ""}`;
  };
  const d = appDetailsMessages.resolve([props.locale]).t;
  const permissionLabels: Readonly<Record<string, string>> = {
    "mail:send": d.permissionMailSend,
    "mail:read": d.permissionMailRead,
    "resources:readers": d.permissionResourceReaders,
    "geo:query": d.permissionGeoQuery,
  };
  const services = () => {
    if (neverStarted || providerOnly) return "–";
    if (!details) return t.notLoaded;
    const labels = details.access.platformPermissions.map((permission) => permissionLabels[permission] ?? permission);
    return labels.length ? labels.join(", ") : t.none;
  };
  // Routes and capabilities have their place in the views; the rest of the providers' links sit under "More".
  const links = entry.numbers.flatMap((item) => item.links).filter((link) => link.kind !== "routes" && link.kind !== "capabilities");
  return (
    <>
      <For each={entry.hints.filter((hint) => hint.kind !== "rotation")}>{(hint) => <Hint {...props} hint={hint} />}</For>
      <For each={props.app.providerFailures}>
        {(provider) => (
          <Notice
            tone="note"
            icon="cloud-off"
            title={t.providerDownLead({ provider })}
            actions={[{ label: t.reload, icon: "refresh", href: appsHref({ app: entry.id, list: props.list }) }]}
          >
            {t.providerDownText}
          </Notice>
        )}
      </For>
      <Show when={!details && !neverStarted && !providerOnly}>
        <Notice
          tone="bad"
          title={t.detailsFailedLead}
          actions={[{ label: t.reload, icon: "refresh", href: appsHref({ app: entry.id, list: props.list }) }]}
        >
          {t.detailsFailedText}
        </Notice>
      </Show>
      <FactRows
        {...props}
        app={entry.id}
        icon="activity"
        title={t.groupState}
        facts={[
          { label: t.runtime, value: runtime(), view: neverStarted ? null : "runtime" },
          {
            label: t.routes,
            value: entry.routes.length ? `${routes.shown}${routes.more ? ` +${routes.more}` : ""}` : "–",
            view: neverStarted ? null : "routes",
          },
          { label: t.traffic, value: neverStarted ? "–" : (values.traffic ?? t.unavailable), view: neverStarted ? null : "routes" },
          {
            label: t.errors,
            value: neverStarted ? "–" : (values.errors ?? t.unavailable),
            view: neverStarted || providerOnly ? null : "errors",
          },
        ]}
      />
      <FactRows
        {...props}
        app={entry.id}
        icon="plug-connected"
        title={t.groupOverview}
        facts={[
          { label: t.access, value: access(), view: neverStarted || providerOnly ? null : "access" },
          { label: t.keys, value: props.app.keysSupported ? keys() : "–", view: providerOnly || !props.app.keysSupported ? null : "keys" },
          domains() !== null && { label: t.domains, value: domains() ?? "", view: "domains" },
          { label: t.events, value: events(), view: neverStarted || providerOnly || !details ? null : "events" },
          {
            label: t.notifications,
            value: neverStarted || providerOnly ? "–" : details ? t.kinds({ count: details.totals.notifications }) : t.notLoaded,
          },
          { label: t.platformServices, value: services() },
        ]}
      />
      <Section
        icon="dots"
        title={t.groupMore}
        actions={
          entry.removable && !neverStarted
            ? [
                {
                  label: t.removeTerm,
                  icon: "trash",
                  onClick: () => void openRemoveDialog({ id: entry.id, name: entry.name }, props.locale),
                },
              ]
            : undefined
        }
      >
        <Show when={entry.adminHref}>
          {(href) => <Row lines={[t.adminOf({ name: entry.name }), t.settingsTerm]} icon="settings" href={href()} />}
        </Show>
        <For each={links}>{(link) => <Row lines={[link.label, t.open]} icon="external-link" href={link.href} />}</For>
        <Show when={!entry.removable || neverStarted}>
          <Text type="meta" muted>
            {neverStarted ? t.removeOffNever : t.removeOffValue}
          </Text>
        </Show>
      </Section>
    </>
  );
}

/** What the app hears and sends, and what it can notify about; failed deliveries can be sent again. */
export function EventsView(props: Ctx & { app: AppPageData; redeliver: (id: string) => void; busy: (id: string) => boolean }) {
  const t = props.t;
  const d = appDetailsMessages.resolve([props.locale]).t;
  const details = () => props.app.details!;
  const time = (value: string | null) => (value ? props.f.dateTime(value) : "");
  return (
    <>
      <Section icon="ear" title={d.hears} count={details().totals.hears} summary={d.hearsHint}>
        <For each={details().hears} fallback={<Text muted>{t.none}</Text>}>
          {(hearing) => (
            <>
              <Row
                lines={[
                  hearing.title ?? hearing.eventType,
                  `${hearing.eventType} v${hearing.version} · ${d.from({ app: props.app.appNames.get(hearing.publisherAppId) ?? hearing.publisherAppId })}${hearing.counts.done ? ` · ${d.delivered({ count: hearing.counts.done })}` : ""}`,
                ]}
                icon="ear"
                end={
                  <Show
                    when={hearing.counts.failed > 0}
                    fallback={
                      <Show when={hearing.state !== "active"}>
                        <Chip status="warn">{hearing.state === "blocked" ? d.blocked : d.cancelled}</Chip>
                      </Show>
                    }
                  >
                    <Chip status="bad">{t.eventsFailed({ count: hearing.counts.failed })}</Chip>
                  </Show>
                }
              />
              <For each={hearing.failedDeliveries}>
                {(delivery) => (
                  <Row
                    lines={[
                      `${d.failedState} · ${[delivery.code, time(delivery.lastAttemptAt), d.attempts({ count: delivery.attempts })].filter(Boolean).join(" · ")}`,
                      delivery.lastError ?? "",
                    ]}
                    icon="alert-triangle"
                    action={
                      hearing.state === "active"
                        ? {
                            label: d.redeliver,
                            icon: "send",
                            onClick: () => props.redeliver(delivery.id),
                            disabled: props.busy(delivery.id),
                          }
                        : undefined
                    }
                  />
                )}
              </For>
            </>
          )}
        </For>
        <Show when={details().totals.hears > details().hears.length}>
          <Text type="meta" muted>
            {`cld events subscriptions --app ${props.app.entry.id}`}
          </Text>
        </Show>
      </Section>
      <Section icon="send" title={d.sends} count={details().totals.sends} summary={d.sendsHint}>
        <For each={details().sends} fallback={<Text muted>{t.none}</Text>}>
          {(event) => (
            <Row
              lines={[event.title, `${event.type} v${event.version} · ${d.subscribers({ count: event.subscriberCount })}`]}
              icon="send"
              end={
                <Show when={event.place}>
                  <Chip>{d.resourceEvent}</Chip>
                </Show>
              }
            />
          )}
        </For>
      </Section>
      <Section icon="bell" title={t.notifications} count={details().totals.notifications} summary={d.notificationsHint}>
        <For each={details().notifications} fallback={<Text muted>{t.none}</Text>}>
          {(notification) => (
            <Row
              lines={[
                notification.label,
                [
                  notification.requiredChannels.length ? d.required({ channels: notification.requiredChannels.join(", ") }) : null,
                  notification.recommendedChannels.length ? d.recommended({ channels: notification.recommendedChannels.join(", ") }) : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
              ]}
              icon="bell"
            />
          )}
        </For>
      </Section>
    </>
  );
}

/** The app's routes with their traffic in a window, and whether the router sends them to this app. */
export function RoutesView(props: Ctx & { detail: Extract<DetailData, { view: "routes" }>; app: AppPageData }) {
  const t = props.t;
  const f = props.f;
  const entry = props.app.entry;
  const misrouted = () => (props.detail.tables[0]?.rows ?? []).filter((row) => row.router === "missing");
  return (
    <>
      <Tabs
        label={t.window}
        items={WINDOWS.map((window) => ({
          label: t.windowLabel({ window }),
          href: appsHref({ app: entry.id, view: "routes", window, list: props.list }),
          current: window === props.detail.window,
        }))}
      />
      <For each={props.detail.failures}>
        {(provider) => (
          <Notice
            tone="note"
            icon="cloud-off"
            actions={[
              {
                label: t.reload,
                icon: "refresh",
                href: appsHref({ app: entry.id, view: "routes", window: props.detail.window, list: props.list }),
              },
            ]}
          >
            {t.providerDownRoutes({ provider })}
          </Notice>
        )}
      </For>
      <Show when={!props.detail.routerKnown}>
        <Notice tone="note" icon="help-circle" title={t.routerUnknownHintLead}>
          {t.routerUnknownHintText}
        </Notice>
      </Show>
      <For each={misrouted()}>
        {(row) => (
          <Notice tone="warn" icon="route-off">
            {row.owner
              ? t.routeOwnerHint({ prefix: row.prefix, name: entry.name, owner: row.owner })
              : t.hintRouteMissingText({ name: entry.name, owner: null })}
          </Notice>
        )}
      </For>
      <For each={props.detail.tables}>
        {(table) => (
          <Section icon="route" title={t.numbersFrom({ providers: table.provider ?? "–" })}>
            <Table
              label={t.routes}
              rows={table.rows}
              rowKey={(row) => row.prefix}
              columns={[
                { title: t.route, width: { min: 140, default: 180 }, cell: (row) => row.prefix },
                {
                  title: t.requests,
                  align: "end",
                  width: { min: 80, default: 100 },
                  cell: (row) =>
                    table.provider === null || row.router === "missing" || row.requests === null ? "–" : f.number(row.requests),
                },
                {
                  title: t.errors,
                  align: "end",
                  width: { min: 70, default: 90 },
                  cell: (row) => (table.provider === null || row.router === "missing" || row.errors === null ? "–" : f.number(row.errors)),
                },
                {
                  title: t.router,
                  drop: true,
                  cell: (row) =>
                    row.router === "missing" ? (
                      <Chip status="bad">{t.routerMissing}</Chip>
                    ) : row.router === "unknown" ? (
                      t.routerUnknown
                    ) : (
                      <Chip status="ok">{t.routerActive}</Chip>
                    ),
                },
              ]}
              phone={(row) => ({
                lines: [
                  row.prefix,
                  row.requests === null ? "–" : `${f.number(row.requests)} · ${row.errors === null ? "–" : f.number(row.errors)}`,
                ],
              })}
            />
          </Section>
        )}
      </For>
      <FootLinks
        links={[
          ...(props.detail.telemetryHref ? [{ label: t.openTelemetry, href: props.detail.telemetryHref }] : []),
          ...(props.detail.routesHref ? [{ label: t.allRoutes, href: props.detail.routesHref }] : []),
        ]}
      />
    </>
  );
}

/** Links out of a view, at its end. */
const FootLinks = (props: { links: ReadonlyArray<{ label: string; href: string }> }) => (
  <Show when={props.links.length > 0}>
    <Bar
      end={
        <For each={props.links}>
          {(link) => (
            <Button variant="text" icon="external-link" href={link.href}>
              {link.label}
            </Button>
          )}
        </For>
      }
    />
  </Show>
);

/** How the app runs: version, build, heartbeat, its instances and how it is part of Cloud. */
export function RuntimeView(props: Ctx & { detail: Extract<DetailData, { view: "runtime" }>; app: AppPageData }) {
  const t = props.t;
  const f = props.f;
  const d = props.detail;
  const entry = props.app.entry;
  return (
    <>
      <For each={d.issues}>{(issue) => <Notice tone={issue.severity === "error" ? "bad" : "warn"}>{issue.message}</Notice>}</For>
      <Section icon="activity" title={t.titleRuntime}>
        <Facts
          items={[
            { label: t.state, value: statusLabel(t, entry.status) },
            { label: t.version, value: d.release ?? t.unknown },
            { label: t.build, value: d.build ?? t.unknown, mono: !!d.build },
            { label: t.sync, value: d.sync ?? t.unknown },
            { label: t.baseUrl, value: d.baseUrl ?? t.unknown, mono: !!d.baseUrl },
            { label: t.heartbeat, value: d.heartbeatAt ? f.relative(d.heartbeatAt) : t.unknown },
            { label: t.runningSince, value: d.startedAt ? `${f.relative(d.startedAt)} · ${f.dateTime(d.startedAt)}` : t.unknown },
          ]}
        />
      </Section>
      <Section icon="server" title={t.instancesTitle} count={d.instances.length}>
        <For each={d.instances} fallback={<Text muted>{t.none}</Text>}>
          {(instance) => (
            <Row
              lines={[
                instance.hostname,
                `${t.startedAt({ time: f.dateTime(instance.startedAt) })} · ${
                  instance.via === "key"
                    ? instance.keyName
                      ? t.viaKey({ key: instance.keyName })
                      : t.viaKeyUnknown
                    : instance.via === "env"
                      ? t.viaEnv
                      : t.viaUnknown
                }`,
              ]}
              icon="server"
            />
          )}
        </For>
      </Section>
      <Section icon="puzzle" title={t.integration}>
        <Row lines={[d.inRail ? t.inRail : t.noneShort, t.navigation]} icon={d.inRail ? "check" : "minus"} />
        <Row
          lines={[d.adminHref ? t.adminOf({ name: entry.name }) : t.noneShort, t.administration]}
          icon={d.adminHref ? "check" : "minus"}
          href={d.adminHref ?? undefined}
        />
        <Row
          lines={[d.capabilities ? `${d.capabilities} ${t.offered}` : t.noneShort, t.capabilities]}
          icon={d.capabilities ? "check" : "minus"}
          href={d.capabilities ? (d.capabilitiesHref ?? undefined) : undefined}
        />
      </Section>
    </>
  );
}

/** Failed deliveries and failed requests, each provider under its own name. */
export function ErrorsView(props: Ctx & { detail: Extract<DetailData, { view: "errors" }>; app: AppPageData }) {
  const t = props.t;
  const f = props.f;
  const d = props.detail;
  const deliveries = () => props.app.details?.hears.reduce((sum, hearing) => sum + hearing.counts.failed, 0) ?? 0;
  return (
    <>
      <Show when={deliveries() > 0}>
        <Notice
          tone="bad"
          actions={[{ label: t.showEvents, href: appsHref({ app: props.app.entry.id, view: "events", list: props.list }) }]}
        >
          {`${deliveries()} ${t.deliveriesFailed}`}
        </Notice>
      </Show>
      <For each={d.failures}>
        {(provider) => (
          <Notice tone="note" icon="cloud-off">
            {t.providerDownRoutes({ provider })}
          </Notice>
        )}
      </For>
      <For each={d.groups}>
        {(group) => {
          const total = group.total ?? group.failedRequests.length;
          return (
            <Section icon="alert-triangle" title={t.failedRequests} count={total} summary={t.errorsSource({ providers: group.provider })}>
              <For each={group.failedRequests} fallback={<Text muted>{t.noFailedRequests}</Text>}>
                {(request) => (
                  <Row
                    lines={[`${request.method} ${request.path}`, f.dateTime(request.at)]}
                    icon="alert-triangle"
                    end={<Chip status="bad">{String(request.status)}</Chip>}
                  />
                )}
              </For>
              <Show when={total > group.failedRequests.length && d.telemetryHref}>
                {(href) => (
                  <Text type="meta" muted href={href()}>
                    {`${t.moreInTelemetry({ count: total - group.failedRequests.length })} ${t.openTelemetry}`}
                  </Text>
                )}
              </Show>
            </Section>
          );
        }}
      </For>
      <FootLinks
        links={[
          ...(d.telemetryHref ? [{ label: t.openTelemetry, href: d.telemetryHref }] : []),
          ...(d.logsHref ? [{ label: t.logs, href: d.logsHref }] : []),
        ]}
      />
    </>
  );
}

export type ViewFrame = { children: JSX.Element };
