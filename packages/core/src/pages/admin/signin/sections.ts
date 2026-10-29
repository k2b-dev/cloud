import type { RegistryFormSection } from "../_area/RegistryForm.island";
import { settingsMessages } from "../settings/_components/messages";
import { settingsDocumentationHref } from "../settings/documentation";
import { signinText } from "./area";

/** A section's own guide, when the documentation website has one. */
const guide = (base: string | undefined, topic: string, label: string) => {
  const href = settingsDocumentationHref(base, topic);
  return href ? { label, href } : undefined;
};

const category = (key: "guest" | "login" | "freeipa", extra: string[] = []) => {
  const enabled = `user.category.${key}.enabled`;
  const shown = [`user.category.${key}.visible`, ...extra];
  return { keys: [enabled, ...shown], shownWhen: Object.fromEntries(shown.map((item) => [item, { key: enabled, value: true }])) };
};

/** The fields of each registry section, grouped and ordered by hand. */
export const signinSections = (locale: string, base?: string): RegistryFormSection[] => {
  const t = signinText(locale);
  const s = settingsMessages.resolve([locale]).t;
  return [
    { title: t.guest, description: s.accountCategoriesDescription, ...category("guest") },
    { title: t.login, ...category("login", ["user.category.login.label"]) },
    { title: t.freeipaCategory, ...category("freeipa") },
    {
      title: s.login,
      description: s.loginDescription,
      keys: ["user.session.expiry_hours"],
      link: guide(base, "user.login", s.documentation),
    },
    {
      title: s.appApproval,
      description: s.appApprovalDescription,
      keys: ["user.app_approval.enabled", "user.app_approval.origin", "user.app_approval.label", "user.app_approval.admin_pairing"],
      link: guide(base, "user.appApproval", s.documentation),
    },
  ];
};

export const registrationSections = (locale: string, base?: string): RegistryFormSection[] => {
  const s = settingsMessages.resolve([locale]).t;
  return [
    {
      title: s.registration,
      description: s.registrationDescription,
      keys: ["user.allow_self_registration", "user.account_requests.enabled", "user.local_email_optional", "user.abbr_length"],
      link: guide(base, "user.registration", s.documentation),
    },
    {
      title: s.accountExpiry,
      description: s.accountExpiryDescription,
      keys: ["user.account.local_guest_expires_days", "user.account.local_user_expires_days", "user.account.ipa_expires_days"],
      link: guide(base, "user.expiry", s.documentation),
    },
    {
      title: s.remindersRetention,
      description: s.remindersRetentionDescription,
      keys: [
        "user.account.reminder_cron",
        "user.account.reminder_days",
        "user.account.reminder_history_retention_days",
        "user.account.deleted_accounts_retention_days",
      ],
      link: guide(base, "user.reminders", s.documentation),
    },
    {
      title: s.actionNotice,
      description: s.actionNoticeDescription,
      keys: ["user.action_notice"],
      link: guide(base, "user.actionNotice", s.documentation),
    },
  ];
};

export const securitySections = (locale: string): RegistryFormSection[] => {
  const s = settingsMessages.resolve([locale]).t;
  return [{ title: s.rateLimits, description: s.rateLimitsDescription, keys: ["security.rate_limit_per_second"] }];
};

export const freeipaSections = (locale: string, base?: string): RegistryFormSection[] => {
  const s = settingsMessages.resolve([locale]).t;
  return [
    {
      title: s.connection,
      description: s.freeIpaConnectionDescription,
      keys: ["freeipa.enable", "freeipa.url", "freeipa.ca_cert", "freeipa.allow_insecure"],
      link: guide(base, "freeipa.connection", s.documentation),
    },
    {
      title: s.serviceAccount,
      description: s.serviceAccountDescription,
      keys: ["freeipa.service_user", "freeipa.service_password"],
      link: guide(base, "freeipa.service", s.documentation),
    },
    {
      title: s.groupMapping,
      description: s.groupMappingDescription,
      keys: ["freeipa.groups.base_ipa_realm", "freeipa.groups.base_sync", "freeipa.groups.admin", "freeipa.groups.excluded"],
      link: guide(base, "freeipa.groups", s.documentation),
    },
    {
      title: s.syncPolicy,
      description: s.syncPolicyDescription,
      keys: [
        "freeipa.sync_cron",
        "freeipa.user_match_mode",
        "freeipa.account_transition_policy",
        "freeipa.sync_guard.max_user_changes",
        "freeipa.sync_guard.max_user_change_percent",
        "freeipa.sync_guard.max_group_deletions",
        "freeipa.sync_guard.max_group_deletion_percent",
      ],
      link: guide(base, "freeipa.sync", s.documentation),
    },
  ];
};
