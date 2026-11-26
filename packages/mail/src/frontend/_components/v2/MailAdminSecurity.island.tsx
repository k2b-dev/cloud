import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { refreshCurrentPath, swapPage } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { mutation } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import {
  Band,
  Bar,
  Chip,
  confirm,
  Failed,
  Inline,
  Input,
  Mark,
  Menu,
  type MenuEntry,
  type NavProps,
  Pane,
  Spark,
  type Status,
  Table,
  Tabs,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createMemo, createSignal, type JSX, Match, Show, Switch } from "solid-js";
import { apiClient } from "../../../api/client";
import type { MailProtectedIdentity, MailSecurityPolicy, MailSecurityReport } from "../../../security-contracts";
import { mailPageMessages } from "../../pages-messages";
import { readApiError } from "../api-response";
import { mailSettingsMessages } from "../mail-settings-messages";
import MailAdminSecurityDetail, { type SecurityOpen } from "./MailAdminSecurityDetail";
import {
  MailProtectedIdentityDialog,
  MailReportDecisionDialog,
  MailSecurityRuleDialog,
  MailTrustedAuthenticationDialog,
  type ReportDecision,
} from "./mail-admin-security-dialogs";

export type SecurityView = "reports" | "rules" | "identities";
export type SecuritySearches = Record<SecurityView, string>;

/** A report as the table shows it; the page words its state and findings. */
export type SecurityReportRow = {
  report: MailSecurityReport;
  state: { label: string; status?: Status };
  findings: string;
  updated: { text: string; title: string; iso: string };
};
export type SecurityRuleRow = { policy: MailSecurityPolicy; rule: string; target: string };

export type MailAdminSecurityProps = {
  nav: NavProps;
  view: SecurityView;
  searches: SecuritySearches;
  figures: { open: number; blocking: number; trusted: number; paused: number; identities: number };
  /** Reports received per day over the last 30 days, oldest first (`countReportsPerDay`); `null` when it could not load. */
  reportsPerDay: number[] | null;
  reports: { rows: SecurityReportRow[]; total: number } | { failed: string };
  rules: { rows: SecurityRuleRow[]; total: number } | { failed: string };
  identities: { rows: MailProtectedIdentity[]; total: number } | { failed: string };
  /** `null` when the settings could not be loaded: the authentication servers cannot be changed then. */
  trustedAuthservIds: string[] | null;
  /** The id of the entry open beside the list (`?open=`), from the open tab's rows. */
  open: string | null;
  dateConfig: DateContext;
};

/** The address of a view with every search; old links (`?reports=…&rules=…`) keep working, the view is `view`. */
export const securityHref = (view: SecurityView, searches: SecuritySearches, open?: string): string => {
  const params = new URLSearchParams();
  if (view !== "reports") params.set("view", view);
  for (const key of ["reports", "rules", "identities"] as const) if (searches[key]) params.set(key, searches[key]);
  if (open) params.set("open", open);
  return params.size ? `/admin/mail/security?${params}` : "/admin/mail/security";
};

const SECURITY_COLOR = "#b45309";

type Open =
  | { kind: "rule" }
  | { kind: "identity" }
  | { kind: "authentication" }
  | { kind: "decision"; report: MailSecurityReport; decision: ReportDecision };

/**
 * Cloud administration › Mail › Security on v2, after the home recipe with a tab per list: four key figures, then the
 * reports, the rules or the protected identities as one dense table with its own search. "+" adds a rule or protects
 * an identity, "⋯" holds the trusted authentication servers, and each row's "⋯" its deeds.
 */
export default function MailAdminSecurity(props: MailAdminSecurityProps) {
  const locale = useLocale();
  const t = createMemo(() => mailPageMessages.resolve([locale()]).t);
  const words = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const toast = useToast();
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const [open, setOpen] = createSignal<Open>();
  const decision = createMemo(() => {
    const now = open();
    return now?.kind === "decision" ? now : undefined;
  });
  const closed = (saved: boolean) => {
    setOpen(undefined);
    if (saved) refreshCurrentPath();
  };

  // the deeds of a row that need no form: each asks first where it cannot be taken back
  const act = mutation.create<boolean, () => Promise<boolean>>({
    mutation: (deed) => deed(),
    onSuccess: (changed) => changed && refreshCurrentPath(),
    onError: (error) => toast(error.message, { status: "bad" }),
  });
  const blockSender = (report: MailSecurityReport) =>
    void act.mutate(async () => {
      if (!report.senderAddress) return false;
      const agreed = await confirm({
        title: words().blockSenderQuestion({ address: report.senderAddress }),
        description: words().blockReportedSenderDescription,
        confirm: words().blockSender,
      });
      if (!agreed) return false;
      const response = await apiClient.admin.security.policies.$post({
        json: {
          disposition: "deny",
          target: "sender_address",
          value: report.senderAddress,
          note: words().phishingReportNote({ id: report.id }),
          enabled: true,
        },
      });
      if (!response.ok) throw new Error(await readApiError(response, words().failedBlockReportedSender));
      return true;
    });
  const toggleRule = (policy: MailSecurityPolicy) =>
    void act.mutate(async () => {
      const response = await apiClient.admin.security.policies[":policyId"].$patch({
        param: { policyId: policy.id },
        json: { enabled: !policy.enabled },
      });
      if (!response.ok) throw new Error(await readApiError(response, words().failedUpdateRule));
      return true;
    });
  const deleteRule = (policy: MailSecurityPolicy) =>
    void act.mutate(async () => {
      const agreed = await confirm({
        title: words().deleteRuleQuestion({ value: policy.value }),
        description: words().deleteRuleDescription,
        confirm: words().deleteRule,
      });
      if (!agreed) return false;
      const response = await apiClient.admin.security.policies[":policyId"].$delete({ param: { policyId: policy.id } });
      if (!response.ok) throw new Error(await readApiError(response, words().failedDeleteRule));
      return true;
    });
  const removeIdentity = (identity: MailProtectedIdentity) =>
    void act.mutate(async () => {
      const agreed = await confirm({
        title: words().stopProtectingQuestion({ name: identity.name }),
        description: words().stopProtectingDescription,
        confirm: words().remove,
      });
      if (!agreed) return false;
      const response = await apiClient.admin.security["protected-identities"][":identityId"].$delete({
        param: { identityId: identity.id },
      });
      if (!response.ok) throw new Error(await readApiError(response, words().failedRemoveProtectedIdentity));
      return true;
    });

  const reportDeeds = (report: MailSecurityReport): MenuEntry[] => [
    ...(report.status === "new"
      ? [{ label: words().startReview, icon: "shield-search", onClick: () => setOpen({ kind: "decision", report, decision: "in_review" }) }]
      : []),
    { label: words().confirmPhishing, icon: "shield-check", onClick: () => setOpen({ kind: "decision", report, decision: "confirmed" }) },
    { label: words().dismissReport, icon: "shield-off", onClick: () => setOpen({ kind: "decision", report, decision: "dismissed" }) },
    ...(report.senderAddress
      ? [{ label: words().blockReportedSender, icon: "user-x", danger: true, onClick: () => blockSender(report) }]
      : []),
  ];
  const ruleDeeds = (policy: MailSecurityPolicy): MenuEntry[] => [
    {
      label: policy.enabled ? words().disableRule : words().enableRule,
      icon: policy.enabled ? "player-pause" : "player-play",
      onClick: () => toggleRule(policy),
    },
    { label: words().deleteRule, icon: "trash", danger: true, onClick: () => deleteRule(policy) },
  ];
  const identityDeeds = (identity: MailProtectedIdentity): MenuEntry[] => [
    { label: words().removeProtectedIdentity, icon: "trash", danger: true, onClick: () => removeIdentity(identity) },
  ];
  const stateChip = (state: SecurityReportRow["state"]) =>
    state.status ? <Chip status={state.status}>{state.label}</Chip> : <Chip>{state.label}</Chip>;

  const openEntry = (): SecurityOpen | undefined => {
    if (!props.open) return undefined;
    if (props.view === "reports" && "rows" in props.reports) {
      const row = props.reports.rows.find((entry) => entry.report.id === props.open);
      return row ? { kind: "report", report: row.report, state: row.state, findings: row.report.assessment.findings } : undefined;
    }
    if (props.view === "rules" && "rows" in props.rules) {
      const row = props.rules.rows.find((entry) => entry.policy.id === props.open);
      return row ? { kind: "rule", policy: row.policy, rule: row.rule, target: row.target } : undefined;
    }
    if (props.view === "identities" && "rows" in props.identities) {
      const identity = props.identities.rows.find((entry) => entry.id === props.open);
      return identity ? { kind: "identity", identity } : undefined;
    }
    return undefined;
  };
  const openDeeds = (open: SecurityOpen): MenuEntry[] =>
    open.kind === "report" ? reportDeeds(open.report) : open.kind === "rule" ? ruleDeeds(open.policy) : identityDeeds(open.identity);
  const listHref = () => securityHref(props.view, props.searches);
  const search = (text: string) => void swapPage(securityHref(props.view, { ...props.searches, [props.view]: text.trim() }));
  const searchWords = () =>
    props.view === "rules"
      ? { label: t().searchRulesLabel, placeholder: t().searchRulesPlaceholder }
      : props.view === "identities"
        ? { label: t().searchIdentitiesLabel, placeholder: t().searchIdentitiesPlaceholder }
        : { label: t().searchReportsLabel, placeholder: t().searchReportsPlaceholder };
  const count = (list: { total: number } | { failed: string }) => ("total" in list ? number(list.total) : undefined);
  const failedOr = <T,>(
    list: { rows: T[]; total: number } | { failed: string },
    view: (list: { rows: T[]; total: number }) => JSX.Element,
  ) => ("failed" in list ? <Failed text={list.failed} onRetry={() => refreshCurrentPath()} /> : view(list));

  return (
    <AdminWorkspace
      nav={props.nav}
      detail
      detailEmpty={{ icon: "shield", text: t().noneOpen }}
      head={
        <Bar
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={searchWords().label}
                placeholder={searchWords().placeholder}
                value={props.searches[props.view]}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") search(input.value);
                  if (event.key === "Escape" && input.value) {
                    input.value = "";
                    search("");
                  }
                }}
              />
              <Menu
                icon="plus"
                label={words().addRule}
                items={[
                  { label: words().addRule, icon: "shield-plus", onClick: () => setOpen({ kind: "rule" }) },
                  { label: words().protectIdentity, icon: "user-shield", onClick: () => setOpen({ kind: "identity" }) },
                ]}
              />
              <Menu
                label={t().moreActions}
                items={[
                  {
                    label: words().authentication,
                    icon: "certificate",
                    disabled: props.trustedAuthservIds === null,
                    meta: props.trustedAuthservIds === null ? words().authenticationSettingsLoadFailed : undefined,
                    onClick: () => setOpen({ kind: "authentication" }),
                  },
                ]}
              />
            </>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={t().phishingProtection}
          // the list keeps its ideal width; what a row opens stands beside it (identity B, rule 5)
          width={{ min: 520, default: 640 }}
          scrollKey={`mail-admin-security-${props.view}`}
          head={
            <Tabs
              label={t().phishingProtection}
              items={[
                {
                  label: t().tabReports,
                  icon: "flag",
                  count: count(props.reports),
                  current: props.view === "reports",
                  href: securityHref("reports", props.searches),
                },
                {
                  label: t().tabRules,
                  icon: "shield",
                  count: count(props.rules),
                  current: props.view === "rules",
                  href: securityHref("rules", props.searches),
                },
                {
                  label: t().tabIdentities,
                  icon: "user-shield",
                  count: count(props.identities),
                  current: props.view === "identities",
                  href: securityHref("identities", props.searches),
                },
              ]}
            />
          }
        >
          {/* the hero's place (DP's hero band takes it): the open reports with their real trend, then one line of exceptions */}
          <Band label={t().phishingProtection}>
            <Inline>
              <Text type="lead">{t().openReportsHero({ count: props.figures.open, shown: number(props.figures.open) })}</Text>
              <Show when={props.reportsPerDay}>
                {(days) => <Spark values={days()} label={t().reportsPerDay({ days: days().length })} />}
              </Show>
            </Inline>
            <Text type="meta" muted>
              {[
                t().reportsOpenSub,
                props.reportsPerDay
                  ? t().reportsReceived({
                      shown: number(props.reportsPerDay.reduce((sum, day) => sum + day, 0)),
                      days: props.reportsPerDay.length,
                    })
                  : undefined,
                t().rulesSplit({ blocking: number(props.figures.blocking), trusted: number(props.figures.trusted) }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            <Show when={props.figures.paused > 0 || props.trustedAuthservIds === null}>
              <Text>
                <Show when={props.figures.paused > 0}>
                  <Text tone="warn" weight="medium">
                    ● {t().pausedRules({ count: props.figures.paused, shown: number(props.figures.paused) })}
                  </Text>
                </Show>
                {"   "}
                <Show when={props.trustedAuthservIds === null}>
                  <Text tone="bad" weight="medium">
                    ● {words().authenticationSettingsLoadFailed}
                  </Text>
                </Show>
              </Text>
            </Show>
          </Band>
          <Switch>
            <Match when={props.view === "reports"}>
              {failedOr(props.reports, (list) => (
                <Table
                  label={t().reportedMessages}
                  rows={list.rows}
                  rowKey={(row) => row.report.id}
                  open={(row) => ({ href: securityHref(props.view, props.searches, row.report.id) })}
                  current={props.open ?? undefined}
                  empty={
                    props.searches.reports
                      ? { icon: "search-off", text: t().noMatchingReports({ query: props.searches.reports }) }
                      : { icon: "shield-check", text: t().noReports }
                  }
                  phone={(row) => ({
                    mark: { icon: "flag", color: SECURITY_COLOR },
                    lines: [row.report.senderAddress ?? t().unknownSender, row.findings],
                    // the row is the link to its detail, where its deeds stand
                    marks: stateChip(row.state),
                  })}
                  // the findings give way first (whole in the detail, with the count of reports); sender, state and time stay
                  columns={[
                    {
                      title: t().sender,
                      width: { min: 180, default: 200 },
                      cell: (row) => (
                        <Inline>
                          <Mark icon="flag" color={SECURITY_COLOR} />
                          <Text>{row.report.senderAddress ?? t().unknownSender}</Text>
                        </Inline>
                      ),
                    },
                    {
                      title: t().status,
                      width: { min: 110, default: 120 },
                      cell: (row) => stateChip(row.state),
                    },
                    { title: t().evidence, width: { min: 160, default: 180 }, cell: (row) => row.findings, drop: true },
                    {
                      title: t().updatedColumn,
                      width: { min: 90, default: 100 },
                      align: "end",
                      cell: (row) => (
                        <time dateTime={row.updated.iso} title={row.updated.title}>
                          {row.updated.text}
                        </time>
                      ),
                    },
                  ]}
                />
              ))}
            </Match>
            <Match when={props.view === "rules"}>
              {failedOr(props.rules, (list) => (
                <Table
                  label={t().organizationRules}
                  rows={list.rows}
                  rowKey={(row) => row.policy.id}
                  open={(row) => ({ href: securityHref(props.view, props.searches, row.policy.id) })}
                  current={props.open ?? undefined}
                  empty={
                    props.searches.rules
                      ? { icon: "search-off", text: t().noMatchingRules({ query: props.searches.rules }) }
                      : {
                          icon: "shield",
                          text: t().noRules,
                          action: { label: words().addRule, icon: "shield-plus", onClick: () => setOpen({ kind: "rule" }) },
                        }
                  }
                  phone={(row) => ({
                    mark: { icon: row.policy.disposition === "deny" ? "ban" : "circle-check", color: SECURITY_COLOR },
                    lines: [row.policy.value, `${row.rule} · ${row.target}`],
                    marks: row.policy.enabled ? undefined : <Chip>{t().paused}</Chip>,
                  })}
                  // the note drops first, then what the rule matches; the value, the rule and its state stay
                  columns={[
                    {
                      title: t().value,
                      width: { min: 200, default: 280 },
                      cell: (row) => (
                        <Inline>
                          <Mark icon={row.policy.disposition === "deny" ? "ban" : "circle-check"} color={SECURITY_COLOR} />
                          <Text>{row.policy.value}</Text>
                        </Inline>
                      ),
                    },
                    {
                      title: t().rule,
                      width: { min: 100, default: 120 },
                      // blocking is the rule working, not trouble: both kinds stay neutral, their mark tells them apart
                      cell: (row) => <Chip>{row.rule}</Chip>,
                    },
                    { title: t().match, width: { min: 130, default: 160 }, cell: (row) => row.target, drop: true },
                    {
                      title: words().reason,
                      width: { min: 160, default: 260 },
                      cell: (row) => <Text muted>{row.policy.note ?? "–"}</Text>,
                      drop: true,
                    },
                    {
                      title: t().state,
                      width: { min: 100, default: 110 },
                      cell: (row) => <Chip>{row.policy.enabled ? t().healthActive : t().paused}</Chip>,
                    },
                  ]}
                />
              ))}
            </Match>
            <Match when={props.view === "identities"}>
              {failedOr(props.identities, (list) => (
                <Table
                  label={t().protectedIdentities}
                  rows={list.rows}
                  rowKey={(row) => row.id}
                  open={(row) => ({ href: securityHref(props.view, props.searches, row.id) })}
                  current={props.open ?? undefined}
                  empty={
                    props.searches.identities
                      ? { icon: "search-off", text: t().noMatchingIdentities({ query: props.searches.identities }) }
                      : {
                          icon: "user-shield",
                          text: t().noIdentities,
                          action: { label: words().protectIdentity, icon: "user-shield", onClick: () => setOpen({ kind: "identity" }) },
                        }
                  }
                  phone={(row) => ({
                    mark: { icon: "user-shield", color: SECURITY_COLOR },
                    lines: [row.name, row.allowedDomains.join(", ")],
                  })}
                  columns={[
                    {
                      title: t().visibleName,
                      width: { min: 180, default: 240 },
                      cell: (row) => (
                        <Inline>
                          <Mark icon="user-shield" color={SECURITY_COLOR} />
                          <Text>{row.name}</Text>
                        </Inline>
                      ),
                    },
                    { title: t().allowedDomains, width: { min: 200, default: 360 }, cell: (row) => row.allowedDomains.join(", ") },
                    {
                      title: words().reason,
                      width: { min: 160, default: 240 },
                      cell: (row) => <Text muted>{row.note ?? "–"}</Text>,
                      drop: true,
                    },
                  ]}
                />
              ))}
            </Match>
          </Switch>
        </Pane>
        <Show when={openEntry()}>
          {(open) => (
            <MailAdminSecurityDetail open={open()} closeHref={listHref()} deeds={openDeeds(open())} dateConfig={props.dateConfig} />
          )}
        </Show>
      </Pane.Split>
      <Switch>
        <Match when={open()?.kind === "rule"}>
          <MailSecurityRuleDialog open close={closed} />
        </Match>
        <Match when={open()?.kind === "identity"}>
          <MailProtectedIdentityDialog open close={closed} />
        </Match>
        <Match when={open()?.kind === "authentication"}>
          <MailTrustedAuthenticationDialog open close={closed} servers={props.trustedAuthservIds ?? []} />
        </Match>
        <Match when={decision()}>
          {(now) => <MailReportDecisionDialog open close={closed} report={now().report} decision={now().decision} />}
        </Match>
      </Switch>
    </AdminWorkspace>
  );
}
