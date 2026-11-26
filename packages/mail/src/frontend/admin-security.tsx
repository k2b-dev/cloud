import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { ssr } from "../config";
import type { MailSecurityPolicy, MailSecurityReport } from "../security-contracts";
import { type MailRequestContext, security } from "../service";
import { localizeMailError } from "../service/error-messages";
import MailAdminSecurity, {
  type SecurityReportRow,
  type SecurityRuleRow,
  type SecuritySearches,
  type SecurityView,
} from "./_components/v2/MailAdminSecurity.island";
import { mailAdminSections } from "./admin-sections";
import { mailPageMessages } from "./pages-messages";

const matchesSearch = (query: string, values: readonly (string | null | undefined)[]): boolean => {
  const normalized = query.toLocaleLowerCase();
  return normalized === "" || values.some((value) => value?.toLocaleLowerCase().includes(normalized));
};

/**
 * Cloud administration › Mail › Security on v2: reports, rules and protected identities, one tab each (`?view=`), each
 * with its own search in the address as before (`reports`, `rules`, `identities`). Message bodies stay out.
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = mailPageMessages.resolve([locale]);
  const view: SecurityView = c.req.query("view") === "rules" ? "rules" : c.req.query("view") === "identities" ? "identities" : "reports";
  const searches: SecuritySearches = {
    reports: (c.req.query("reports") ?? "").trim(),
    rules: (c.req.query("rules") ?? "").trim(),
    identities: (c.req.query("identities") ?? "").trim(),
  };
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

  const reportState = (status: MailSecurityReport["status"]): SecurityReportRow["state"] => {
    if (status === "new") return { label: t.reportStatusNew, status: "warn" };
    if (status === "in_review") return { label: t.reportStatusInReview, status: "warn" };
    if (status === "confirmed") return { label: t.reportStatusConfirmed, status: "bad" };
    return { label: t.reportStatusDismissed };
  };
  const policyTarget = (target: MailSecurityPolicy["target"]): string => {
    if (target === "sender_address") return t.targetSenderAddress;
    if (target === "sender_domain") return t.targetSenderDomain;
    return t.targetLinkDomain;
  };
  const findingTitle = (finding: MailSecurityReport["assessment"]["findings"][number]) => {
    if (finding.code === "admin_deny_policy") return t.findingBlockedTitle;
    if (finding.code === "authentication_failed") return t.findingAuthenticationTitle;
    if (finding.code === "reply_to_mismatch") return t.findingReplyToTitle;
    if (finding.code === "misleading_link") return t.findingLinkTitle;
    if (finding.code === "protected_identity_mismatch") return t.findingIdentityTitle;
    return finding.title;
  };

  const reportRows: SecurityReportRow[] = reports
    .filter((report) =>
      matchesSearch(searches.reports, [
        report.status,
        report.senderAddress,
        report.senderDomain,
        report.messageId,
        report.mailboxId,
        ...report.assessment.findings.flatMap((finding) => [finding.title, finding.explanation]),
      ]),
    )
    .map((report) => ({
      report,
      state: reportState(report.status),
      findings: report.assessment.findings.map(findingTitle).join(" · ") || t.reportedByUser,
      updated: {
        text: dates.formatDateTimeRelative(report.updatedAt, dateConfig),
        title: dates.formatDateTime(report.updatedAt, dateConfig),
        iso: report.updatedAt,
      },
    }));
  const ruleRows: SecurityRuleRow[] = policies
    .filter((policy) =>
      matchesSearch(searches.rules, [policy.disposition, policy.target, policy.value, policy.note, policy.enabled ? "active" : "paused"]),
    )
    .map((policy) => ({ policy, rule: policy.disposition === "deny" ? t.block : t.trust, target: policyTarget(policy.target) }));
  const identityRows = identities.filter((identity) =>
    matchesSearch(searches.identities, [identity.name, identity.note, identity.enabled ? "active" : "paused", ...identity.allowedDomains]),
  );

  return () => (
    <AdminLayout c={c} title={t.securityTitle} ui="v2">
      <MailAdminSecurity
        nav={adminNavigation(c, mailAdminSections(locale, "security"))}
        view={view}
        searches={searches}
        figures={{
          open: reports.filter((report) => report.status === "new" || report.status === "in_review").length,
          blocking: policies.filter((policy) => policy.disposition === "deny" && policy.enabled).length,
          trusted: policies.filter((policy) => policy.disposition === "trust" && policy.enabled).length,
          identities: identities.filter((identity) => identity.enabled).length,
        }}
        reports={
          reportsResult.ok
            ? { rows: reportRows, total: reports.length }
            : { failed: `${t.couldNotLoadReports}: ${localizeMailError(reportsResult.error, locale).message}` }
        }
        rules={
          policiesResult.ok
            ? { rows: ruleRows, total: policies.length }
            : { failed: `${t.couldNotLoadRules}: ${localizeMailError(policiesResult.error, locale).message}` }
        }
        identities={
          identitiesResult.ok
            ? { rows: identityRows, total: identities.length }
            : { failed: `${t.couldNotLoadIdentities}: ${localizeMailError(identitiesResult.error, locale).message}` }
        }
        trustedAuthservIds={settingsResult.ok ? settingsResult.data.trustedAuthservIds : null}
      />
    </AdminLayout>
  );
});
