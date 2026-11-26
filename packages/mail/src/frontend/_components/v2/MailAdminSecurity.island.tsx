import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { refreshCurrentPath, swapPage } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Cells,
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
  figures: { open: number; blocking: number; trusted: number; identities: number };
  reports: { rows: SecurityReportRow[]; total: number } | { failed: string };
  rules: { rows: SecurityRuleRow[]; total: number } | { failed: string };
  identities: { rows: MailProtectedIdentity[]; total: number } | { failed: string };
  /** `null` when the settings could not be loaded: the authentication servers cannot be changed then. */
  trustedAuthservIds: string[] | null;
};

/** The address of a view with every search; old links (`?reports=…&rules=…`) keep working, the view is `view`. */
export const securityHref = (view: SecurityView, searches: SecuritySearches): string => {
  const params = new URLSearchParams();
  if (view !== "reports") params.set("view", view);
  for (const key of ["reports", "rules", "identities"] as const) if (searches[key]) params.set(key, searches[key]);
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
  const deeds = (label: string, items: MenuEntry[]) => <Menu label={words().moreActionsFor({ name: label })} items={items} />;

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
      <Pane
        label={t().phishingProtection}
        scrollKey={`mail-admin-security-${props.view}`}
        head={
          <Tabs
            label={t().phishingProtection}
            items={[
              {
                label: t().reportedMessages,
                icon: "flag",
                count: count(props.reports),
                current: props.view === "reports",
                href: securityHref("reports", props.searches),
              },
              {
                label: t().organizationRules,
                icon: "shield",
                count: count(props.rules),
                current: props.view === "rules",
                href: securityHref("rules", props.searches),
              },
              {
                label: t().protectedIdentities,
                icon: "user-shield",
                count: count(props.identities),
                current: props.view === "identities",
                href: securityHref("identities", props.searches),
              },
            ]}
          />
        }
      >
        <Cells>
          <Cells.Cell
            icon="shield-exclamation"
            color={SECURITY_COLOR}
            label={t().openReports}
            value={props.figures.open ? <Chip status="warn">{number(props.figures.open)}</Chip> : "0"}
            meta={t().reportsOpenSub}
          />
          <Cells.Cell icon="ban" label={t().blockingRules} value={number(props.figures.blocking)} meta={t().exactMatches} />
          <Cells.Cell
            icon="circle-check"
            label={t().trustedSenders}
            value={number(props.figures.trusted)}
            meta={t().authenticationRequired}
          />
          <Cells.Cell
            icon="user-shield"
            label={t().protectedIdentities}
            value={number(props.figures.identities)}
            meta={t().visibleSenderNames}
          />
        </Cells>
        <Switch>
          <Match when={props.view === "reports"}>
            {failedOr(props.reports, (list) => (
              <Table
                label={t().reportedMessages}
                rows={list.rows}
                rowKey={(row) => row.report.id}
                empty={
                  props.searches.reports
                    ? { icon: "search-off", text: t().noMatchingReports({ query: props.searches.reports }) }
                    : { icon: "shield-check", text: t().noReports }
                }
                phone={(row) => ({
                  mark: { icon: "flag", color: SECURITY_COLOR },
                  lines: [row.report.senderAddress ?? t().unknownSender, row.findings],
                  time: row.updated.text,
                  marks: (
                    <Inline>
                      {stateChip(row.state)}
                      {deeds(row.report.senderAddress ?? row.report.id, reportDeeds(row.report))}
                    </Inline>
                  ),
                })}
                // the date drops first, then the count of reports; sender, finding and state stay
                columns={[
                  {
                    title: t().sender,
                    width: { min: 200, default: 260 },
                    cell: (row) => (
                      <Inline>
                        <Mark icon="flag" color={SECURITY_COLOR} />
                        <Text>{row.report.senderAddress ?? t().unknownSender}</Text>
                      </Inline>
                    ),
                  },
                  {
                    title: t().status,
                    width: { min: 120, default: 130 },
                    cell: (row) => {
                      stateChip(row.state);
                    },
                  },
                  { title: t().evidence, width: { min: 200, default: 320 }, cell: (row) => row.findings },
                  {
                    title: t().reports,
                    width: { min: 80, default: 90 },
                    align: "end",
                    cell: (row) => number(row.report.reportCount),
                    drop: true,
                  },
                  {
                    title: t().updatedColumn,
                    width: { min: 110, default: 130 },
                    cell: (row) => (
                      <time dateTime={row.updated.iso} title={row.updated.title}>
                        {row.updated.text}
                      </time>
                    ),
                    drop: true,
                  },
                  {
                    title: t().actions,
                    width: { fixed: 56 },
                    align: "end",
                    cell: (row) => deeds(row.report.senderAddress ?? row.report.id, reportDeeds(row.report)),
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
                  marks: (
                    <Inline>
                      <Show when={!row.policy.enabled}>
                        <Chip>{t().paused}</Chip>
                      </Show>
                      {deeds(row.policy.value, ruleDeeds(row.policy))}
                    </Inline>
                  ),
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
                    cell: (row) => <Chip status={row.policy.disposition === "deny" ? "bad" : "ok"}>{row.rule}</Chip>,
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
                    cell: (row) => (row.policy.enabled ? <Chip status="ok">{t().healthActive}</Chip> : <Chip>{t().paused}</Chip>),
                  },
                  { title: t().actions, width: { fixed: 56 }, align: "end", cell: (row) => deeds(row.policy.value, ruleDeeds(row.policy)) },
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
                  marks: deeds(row.name, identityDeeds(row)),
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
                  { title: t().actions, width: { fixed: 56 }, align: "end", cell: (row) => deeds(row.name, identityDeeds(row)) },
                ]}
              />
            ))}
          </Match>
        </Switch>
        <Text type="meta" muted>
          {t().securityDescription}
        </Text>
      </Pane>
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
