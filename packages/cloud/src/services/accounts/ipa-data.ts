import { sql } from "bun";
import type { IpaUserData } from "../../contracts/shared";

type DbRow = Record<string, unknown>;

export const userIpaDataJoin = sql`LEFT JOIN auth.user_ipa_data ui ON ui.user_id = u.id`;

export const userIpaDataColumns = sql`
  CASE WHEN EXISTS(SELECT 1 FROM auth.user_posix p WHERE p.user_id = u.id AND p.managed_by = 'ipa')
    THEN (SELECT p.uid_number FROM auth.user_posix p WHERE p.user_id = u.id AND p.managed_by = 'ipa')
    ELSE ui.uid_number END AS ipa_uid_number,
  ui.phone AS ipa_phone,
  ui.employee_type AS ipa_employee_type,
  ui.mobile AS ipa_mobile,
  ui.addr_street AS ipa_addr_street,
  ui.addr_postal_code AS ipa_addr_postal_code,
  ui.addr_city AS ipa_addr_city,
  ui.addr_state AS ipa_addr_state,
  ui.ipa_password_expires AS ipa_password_expires,
  ui.last_login_ipa AS ipa_last_login_ipa,
  ui.synced_at AS ipa_synced_at,
  ui.ssh_public_keys AS ipa_ssh_public_keys,
  ui.ssh_fingerprints AS ipa_ssh_fingerprints
`;

export const emptyIpaUserData = (): IpaUserData => ({
  uidNumber: null,
  phone: null,
  employeeType: null,
  mobile: null,
  address: {
    street: null,
    postalCode: null,
    city: null,
    state: null,
  },
  passwordExpires: null,
  lastLoginIpa: null,
  syncedAt: null,
  sshPublicKeys: [],
  sshFingerprints: [],
});

export const buildIpaUserData = (row: DbRow): IpaUserData | null => {
  if (!row.ipa_uid_number && !row.ipa_phone && !row.ipa_password_expires && !row.ipa_synced_at && !row.ipa_ssh_public_keys) {
    return null;
  }

  return {
    uidNumber: (row.ipa_uid_number as number) ?? null,
    phone: (row.ipa_phone as string) ?? null,
    employeeType: (row.ipa_employee_type as string) ?? null,
    mobile: (row.ipa_mobile as string) ?? null,
    address: {
      street: (row.ipa_addr_street as string) ?? null,
      postalCode: (row.ipa_addr_postal_code as string) ?? null,
      city: (row.ipa_addr_city as string) ?? null,
      state: (row.ipa_addr_state as string) ?? null,
    },
    passwordExpires: row.ipa_password_expires ? (row.ipa_password_expires as Date).toISOString() : null,
    lastLoginIpa: row.ipa_last_login_ipa ? (row.ipa_last_login_ipa as Date).toISOString() : null,
    syncedAt: row.ipa_synced_at ? (row.ipa_synced_at as Date).toISOString() : null,
    sshPublicKeys: (row.ipa_ssh_public_keys as string[]) ?? [],
    sshFingerprints: (row.ipa_ssh_fingerprints as string[]) ?? [],
  };
};
