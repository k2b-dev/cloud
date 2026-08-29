import type { FilterChipSection } from "@k2b/ui";
import type { AccountsMessages } from "../messages";

const actionEntries = [
  ["accounts.user.create", "createUserAudit", "ti ti-user-plus"],
  ["accounts.user.update", "updateUserAudit", "ti ti-user-edit"],
  ["accounts.user.password_reset", "resetPasswordAudit", "ti ti-key"],
  ["accounts.user.set_expiry", "setExpiryAudit", "ti ti-calendar-due"],
  ["accounts.user.set_profile", "setProfileAudit", "ti ti-badge"],
  ["accounts.user.set_admin", "setAdminAudit", "ti ti-shield"],
  ["accounts.user.switch_provider", "switchProviderAudit", "ti ti-switch-horizontal"],
  ["accounts.user.demote_to_guest", "demoteUserAudit", "ti ti-user-down"],
  ["accounts.user.create_login_token", "createLoginTokenAudit", "ti ti-ticket"],
  ["accounts.user.send_login_link", "sendLoginLinkAudit", "ti ti-mail-share"],
  ["accounts.user.remove", "deleteUserAudit", "ti ti-trash"],
  ["accounts.user.remove_self", "selfDeleteAudit", "ti ti-user-x"],
  ["accounts.user.change_own_password", "changePasswordAudit", "ti ti-lock"],
  ["accounts.user.extend_account", "extendAccountAudit", "ti ti-calendar-plus"],
  ["accounts.group.create", "createGroupAudit", "ti ti-users-plus"],
  ["accounts.group.update", "updateGroupAudit", "ti ti-edit"],
  ["accounts.group.remove", "deleteGroupAudit", "ti ti-trash"],
  ["accounts.group.make_posix", "makePosixAudit", "ti ti-terminal-2"],
  ["accounts.group.member.add", "addMemberAudit", "ti ti-user-plus"],
  ["accounts.group.member.remove", "removeMemberAudit", "ti ti-user-minus"],
  ["accounts.group.manager.add", "addManagerAudit", "ti ti-shield-plus"],
  ["accounts.group.manager.remove", "removeManagerAudit", "ti ti-shield-minus"],
  ["accounts.request.create", "createRequestAudit", "ti ti-inbox"],
  ["accounts.request.withdraw", "withdrawRequestAudit", "ti ti-arrow-back-up"],
  ["accounts.request.deny", "denyRequestAudit", "ti ti-ban"],
  ["service_account_credential.create", "createApiKeyAudit", "ti ti-key"],
  ["service_account_credential.revoke", "revokeApiKeyAudit", "ti ti-key-off"],
  ["service_account_credential.authenticate", "useApiKeyAudit", "ti ti-login"],
] as const;

type ActionEntry = (typeof actionEntries)[number];
type ActionMessageKey = ActionEntry[1];

const labelByAction = new Map<string, ActionMessageKey>(actionEntries.map(([action, key]) => [action, key]));
const option = (entry: ActionEntry, messages: AccountsMessages) => ({
  value: entry[0],
  label: messages[entry[1]],
  icon: entry[2],
});

export const actionLabel = (action: string, messages: AccountsMessages): string => {
  const key = labelByAction.get(action);
  return key ? messages[key] : action;
};

export const actionOptions = (messages: AccountsMessages): FilterChipSection[] => [
  { label: messages.users, options: actionEntries.slice(0, 14).map((entry) => option(entry, messages)) },
  { label: messages.groups, options: actionEntries.slice(14, 22).map((entry) => option(entry, messages)) },
  { label: messages.requests, options: actionEntries.slice(22, 25).map((entry) => option(entry, messages)) },
  { label: messages.serviceAccounts, options: actionEntries.slice(25).map((entry) => option(entry, messages)) },
];
