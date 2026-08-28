import { dates } from "@k2b/stdlib";
import { ButtonLink, DataTable, type DataTableColumn, NoticeCard, Placeholder, StatCell, StatGrid, StatusBadge } from "@k2b/ui";
import { type AuthContext, getDateConfig, getLocale } from "@valentinkolb/cloud/server";
import { AdminLayout } from "@valentinkolb/cloud/ssr";
import { SearchBar } from "@valentinkolb/cloud/ssr/islands";
import { ssr } from "../config";
import type { MailProtectedIdentity, MailSecurityPolicy, MailSecurityReport } from "../security-contracts";
import { type MailRequestContext, security } from "../service";
import { localizeMailError } from "../service/error-messages";
import MailAdminSecurityActions from "./_components/MailAdminSecurityActions.island";
import { mailPageMessages } from "./pages-messages";

const matchesSearch = (query: string, values: readonly (string | null | undefined)[]): boolean => {
  const normalized = query.toLocaleLowerCase();
  return normalized === "" || values.some((value) => value?.toLocaleLowerCase().includes(normalized));
};

const securitySearchAction = (searches: Record<string, string>): string => {
  const params = new URLSearchParams(Object.entries(searches).filter((entry) => entry[1] !== ""));
  const query = params.toString();
  return query ? `/admin/mail/security?${query}` : "/admin/mail/security";
};

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = mailPageMessages.resolve([locale]);
  const securityNotices = [
    { title: t.rulesNoticeTitle, detail: t.rulesNoticeDetail },
    { title: t.identitiesNoticeTitle, detail: t.identitiesNoticeDetail },
  ];
  const reportSearch = (c.req.query("reports") ?? "").trim();
  const policySearch = (c.req.query("rules") ?? "").trim();
  const identitySearch = (c.req.query("identities") ?? "").trim();
  const context: MailRequestContext = {
    actor: c.get("actor"),
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const dateConfig = getDateConfig(c);
  const [reportsResult, policiesResult, identitiesResult, settingsResult] = await Promise.all([
    security.listReports(context, { limit: 100 }),
    security.listPolicies(context),
    security.listProtectedIdentities(context),
    security.getSettings(context),
  ]);
  const reports = reportsResult.ok ? reportsResult.data : [];
  const policies = policiesResult.ok ? policiesResult.data : [];
  const identities = identitiesResult.ok ? identitiesResult.data : [];
  const filteredReports = reports.filter((report) =>
    matchesSearch(reportSearch, [
      report.status,
      report.senderAddress,
      report.senderDomain,
      report.messageId,
      report.mailboxId,
      ...report.assessment.findings.flatMap((finding) => [finding.title, finding.explanation]),
    ]),
  );
  const filteredPolicies = policies.filter((policy) =>
    matchesSearch(policySearch, [policy.disposition, policy.target, policy.value, policy.note, policy.enabled ? "active" : "paused"]),
  );
  const filteredIdentities = identities.filter((identity) =>
    matchesSearch(identitySearch, [identity.name, identity.note, identity.enabled ? "active" : "paused", ...identity.allowedDomains]),
  );
  const openReports = reports.filter((report) => report.status === "new" || report.status === "in_review").length;
  const reportStatusLabel = (status: MailSecurityReport["status"]): string => {
    if (status === "new") return t.reportStatusNew;
    if (status === "in_review") return t.reportStatusInReview;
    if (status === "confirmed") return t.reportStatusConfirmed;
    return t.reportStatusDismissed;
  };
  const policyTargetLabel = (target: MailSecurityPolicy["target"]): string => {
    if (target === "sender_address") return t.targetSenderAddress;
    if (target === "sender_domain") return t.targetSenderDomain;
    return t.targetLinkDomain;
  };
  const findingText = (finding: MailSecurityReport["assessment"]["findings"][number]) => {
    if (finding.code === "admin_deny_policy") return { title: t.findingBlockedTitle, explanation: t.findingBlockedExplanation };
    if (finding.code === "authentication_failed")
      return { title: t.findingAuthenticationTitle, explanation: t.findingAuthenticationExplanation };
    if (finding.code === "reply_to_mismatch") return { title: t.findingReplyToTitle, explanation: t.findingReplyToExplanation };
    if (finding.code === "misleading_link") return { title: t.findingLinkTitle, explanation: t.findingLinkExplanation };
    if (finding.code === "protected_identity_mismatch") return { title: t.findingIdentityTitle, explanation: t.findingIdentityExplanation };
    return finding;
  };
  const reportColumns: DataTableColumn<MailSecurityReport>[] = [
    { id: "status", header: t.status, value: (row) => row.status },
    { id: "sender", header: t.sender, value: (row) => row.senderAddress ?? t.unknown },
    { id: "reason", header: t.evidence, value: (row) => row.assessment.findings.map((finding) => findingText(finding).title).join(", ") },
    { id: "reports", header: t.reports, value: (row) => row.reportCount, headerClass: "text-right", cellClass: "text-right" },
    { id: "updated", header: t.updatedColumn, value: (row) => row.updatedAt },
    { id: "actions", header: t.actions, headerClass: "w-px text-right", cellClass: "text-right" },
  ];
  const policyColumns: DataTableColumn<MailSecurityPolicy>[] = [
    { id: "rule", header: t.rule, value: (row) => row.disposition },
    { id: "target", header: t.match, value: (row) => row.target },
    { id: "value", header: t.value, value: (row) => row.value },
    { id: "state", header: t.state, value: (row) => row.enabled },
    { id: "actions", header: t.actions, headerClass: "w-px text-right", cellClass: "text-right" },
  ];
  const identityColumns: DataTableColumn<MailProtectedIdentity>[] = [
    { id: "name", header: t.visibleName, value: (row) => row.name },
    { id: "domains", header: t.allowedDomains, value: (row) => row.allowedDomains.join(", ") },
    { id: "actions", header: t.actions, headerClass: "w-px text-right", cellClass: "text-right" },
  ];

  return () => (
    <AdminLayout c={c} title={t.securityTitle}>
      <div class="app-rows" data-scroll-preserve="mail-admin-security">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div class="flex items-center gap-2">
              <ButtonLink href="/admin/mail" variant="subtle" size="sm">
                <i class="ti ti-arrow-left" aria-hidden="true" /> Mail
              </ButtonLink>
              <h1 class="text-base font-semibold text-primary">{t.phishingProtection}</h1>
            </div>
            <p class="mt-1 text-xs text-dimmed">{t.securityDescription}</p>
          </div>
          <MailAdminSecurityActions kind="toolbar" trustedAuthservIds={settingsResult.ok ? settingsResult.data.trustedAuthservIds : null} />
        </div>

        <StatGrid columns={4}>
          <StatCell
            label={t.openReports}
            value={openReports}
            sub={t.reportsOpenSub}
            accent={openReports ? { tone: "amber", icon: "ti ti-shield-exclamation" } : undefined}
          />
          <StatCell
            label={t.blockingRules}
            value={policies.filter((policy) => policy.disposition === "deny" && policy.enabled).length}
            sub={t.exactMatches}
          />
          <StatCell
            label={t.trustedSenders}
            value={policies.filter((policy) => policy.disposition === "trust" && policy.enabled).length}
            sub={t.authenticationRequired}
          />
          <StatCell
            label={t.protectedIdentities}
            value={identities.filter((identity) => identity.enabled).length}
            sub={t.visibleSenderNames}
          />
        </StatGrid>

        <NoticeCard.Grid items={securityNotices}>
          {(notice) => <NoticeCard tone="info" title={notice.title} detail={notice.detail} />}
        </NoticeCard.Grid>

        {reportsResult.ok ? (
          <DataTable.Panel class="overflow-hidden">
            <DataTable.Header
              title={t.reportedMessages}
              subtitle={
                reportSearch
                  ? t.filteredReports({ count: filteredReports.length, total: reports.length })
                  : t.recentReports({ count: reports.length })
              }
            />
            <DataTable.Controls>
              <SearchBar
                action={securitySearchAction({ rules: policySearch, identities: identitySearch })}
                value={reportSearch}
                param="reports"
                pageParam="reports-page"
                placeholder={t.searchReportsPlaceholder}
                ariaLabel={t.searchReportsLabel}
              />
            </DataTable.Controls>
            <DataTable
              rows={filteredReports}
              columns={reportColumns}
              getRowId={(row) => row.id}
              hoverRows
              class="overflow-x-auto"
              scrollPreserveKey="mail-admin-security-reports"
              empty={reportSearch ? t.noMatchingReports({ query: reportSearch }) : t.noReports}
              renderCell={({ row, col }) => {
                if (col.id === "status")
                  return (
                    <StatusBadge
                      tone={row.status === "confirmed" ? "error" : row.status === "dismissed" ? "neutral" : "warning"}
                      label={reportStatusLabel(row.status)}
                    />
                  );
                if (col.id === "reason")
                  return (
                    <div class="max-w-xl">
                      <p class="truncate text-xs text-primary">
                        {row.assessment.findings.map((finding) => findingText(finding).title).join(" · ") || t.reportedByUser}
                      </p>
                      <p class="truncate text-[10px] text-dimmed">
                        {row.assessment.findings.map((finding) => findingText(finding).explanation).join(" · ") || t.noAutomaticWarning}
                      </p>
                      <p class="font-mono text-[10px] text-dimmed">
                        {t.messageAndMailbox({ messageId: row.messageId, mailboxId: row.mailboxId })}
                      </p>
                    </div>
                  );
                if (col.id === "sender")
                  return (
                    <div>
                      <p class="font-mono text-xs text-primary">{row.senderAddress ?? t.unknownSender}</p>
                      {row.senderDomain ? <p class="font-mono text-[10px] text-dimmed">{row.senderDomain}</p> : null}
                    </div>
                  );
                if (col.id === "reports") return <span class="tabular-nums">{row.reportCount}</span>;
                if (col.id === "updated")
                  return (
                    <time title={dates.formatDateTime(row.updatedAt, dateConfig)}>
                      {dates.formatDateTimeRelative(row.updatedAt, dateConfig)}
                    </time>
                  );
                if (col.id === "actions") return <MailAdminSecurityActions kind="report" report={row} />;
                return "";
              }}
            />
          </DataTable.Panel>
        ) : (
          <Placeholder
            state="error"
            variant="panel"
            title={t.couldNotLoadReports}
            description={localizeMailError(reportsResult.error, locale).message}
          />
        )}

        {policiesResult.ok ? (
          <DataTable.Panel class="overflow-hidden">
            <DataTable.Header
              title={t.organizationRules}
              subtitle={
                policySearch
                  ? t.filteredRules({ count: filteredPolicies.length, total: policies.length })
                  : t.organizationRuleCount({ count: policies.length })
              }
            />
            <DataTable.Controls>
              <SearchBar
                action={securitySearchAction({ reports: reportSearch, identities: identitySearch })}
                value={policySearch}
                param="rules"
                pageParam="rules-page"
                placeholder={t.searchRulesPlaceholder}
                ariaLabel={t.searchRulesLabel}
              />
            </DataTable.Controls>
            <DataTable
              rows={filteredPolicies}
              columns={policyColumns}
              getRowId={(row) => row.id}
              hoverRows
              class="overflow-x-auto"
              scrollPreserveKey="mail-admin-security-rules"
              empty={policySearch ? t.noMatchingRules({ query: policySearch }) : t.noRules}
              renderCell={({ row, col }) => {
                if (col.id === "rule")
                  return (
                    <StatusBadge
                      tone={row.disposition === "deny" ? "error" : "ok"}
                      label={row.disposition === "deny" ? t.block : t.trust}
                    />
                  );
                if (col.id === "target") return <span class="text-secondary">{policyTargetLabel(row.target)}</span>;
                if (col.id === "value")
                  return (
                    <div>
                      <p class="font-mono text-xs text-primary">{row.value}</p>
                      {row.note ? <p class="text-[10px] text-dimmed">{row.note}</p> : null}
                    </div>
                  );
                if (col.id === "state")
                  return <StatusBadge tone={row.enabled ? "ok" : "neutral"} label={row.enabled ? t.healthActive : t.paused} />;
                if (col.id === "actions") return <MailAdminSecurityActions kind="policy" policy={row} />;
                return "";
              }}
            />
          </DataTable.Panel>
        ) : (
          <Placeholder
            state="error"
            variant="panel"
            title={t.couldNotLoadRules}
            description={localizeMailError(policiesResult.error, locale).message}
          />
        )}

        {identitiesResult.ok ? (
          <DataTable.Panel class="overflow-hidden">
            <DataTable.Header
              title={t.protectedIdentities}
              subtitle={
                identitySearch
                  ? t.filteredIdentities({ count: filteredIdentities.length, total: identities.length })
                  : t.protectedIdentityCount({ count: identities.length })
              }
            />
            <DataTable.Controls>
              <SearchBar
                action={securitySearchAction({ reports: reportSearch, rules: policySearch })}
                value={identitySearch}
                param="identities"
                pageParam="identities-page"
                placeholder={t.searchIdentitiesPlaceholder}
                ariaLabel={t.searchIdentitiesLabel}
              />
            </DataTable.Controls>
            <DataTable
              rows={filteredIdentities}
              columns={identityColumns}
              getRowId={(row) => row.id}
              hoverRows
              class="overflow-x-auto"
              scrollPreserveKey="mail-admin-security-identities"
              empty={identitySearch ? t.noMatchingIdentities({ query: identitySearch }) : t.noIdentities}
              renderCell={({ row, col }) => {
                if (col.id === "name") return <span class="font-medium text-primary">{row.name}</span>;
                if (col.id === "domains") return <span class="font-mono text-xs text-secondary">{row.allowedDomains.join(", ")}</span>;
                if (col.id === "actions") return <MailAdminSecurityActions kind="protected-identity" identity={row} />;
                return "";
              }}
            />
          </DataTable.Panel>
        ) : (
          <Placeholder
            state="error"
            variant="panel"
            title={t.couldNotLoadIdentities}
            description={localizeMailError(identitiesResult.error, locale).message}
          />
        )}
      </div>
    </AdminLayout>
  );
});
