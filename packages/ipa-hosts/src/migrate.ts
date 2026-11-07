import { sql } from "@k2b/cloud";

export const migrate = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS ipa_hosts`.simple();
  console.log("  ✓ ipa_hosts schema");

  await sql`
    CREATE TABLE IF NOT EXISTS ipa_hosts.hosts (
      fqdn TEXT PRIMARY KEY,
      description TEXT,
      location TEXT,
      locality TEXT,
      mac_address TEXT[] NOT NULL DEFAULT '{}',
      platform TEXT,
      os_version TEXT,
      ssh_fingerprints TEXT[] NOT NULL DEFAULT '{}',
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  console.log("  ✓ ipa_hosts.hosts table");

  await sql`
    CREATE TABLE IF NOT EXISTS ipa_hosts.hostgroups (
      cn TEXT PRIMARY KEY,
      description TEXT,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  console.log("  ✓ ipa_hosts.hostgroups table");

  await sql`
    CREATE TABLE IF NOT EXISTS ipa_hosts.host_hostgroups (
      host_fqdn TEXT NOT NULL REFERENCES ipa_hosts.hosts(fqdn) ON DELETE CASCADE,
      hostgroup_cn TEXT NOT NULL REFERENCES ipa_hosts.hostgroups(cn) ON DELETE CASCADE,
      PRIMARY KEY (host_fqdn, hostgroup_cn)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ipa_hosts_host_hostgroups_hostgroup
    ON ipa_hosts.host_hostgroups(hostgroup_cn)
  `.simple();
  console.log("  ✓ ipa_hosts.host_hostgroups table");

  await sql`
    CREATE TABLE IF NOT EXISTS ipa_hosts.hostgroup_hostgroups (
      parent_cn TEXT NOT NULL REFERENCES ipa_hosts.hostgroups(cn) ON DELETE CASCADE,
      child_cn TEXT NOT NULL REFERENCES ipa_hosts.hostgroups(cn) ON DELETE CASCADE,
      PRIMARY KEY (parent_cn, child_cn)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ipa_hosts_hostgroup_hostgroups_child
    ON ipa_hosts.hostgroup_hostgroups(child_cn)
  `.simple();
  console.log("  ✓ ipa_hosts.hostgroup_hostgroups table");
};
