import { expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { hostGet, hostgroupGetWithHosts, hostgroupListWithHosts, hostStats } from "./provider";

suiteFor("database")("the host mirror's records", () => {
  test("a host and a host group are read by their exact name in one statement, behind any number of longer names", async () => {
    await migrate();
    const prefix = `t${crypto.randomUUID().slice(0, 8)}`;
    const target = `${prefix}-server`;
    // 60 groups whose names contain the target's and sort before it: a substring search with a limit would miss it
    const longer = Array.from({ length: 60 }, (_, index) =>
      `${prefix}-server-${String(index).padStart(2, "0")}`.replace("-server-", "-a-server-"),
    );
    // three hosts, inserted out of order; the first one is in two groups
    const hosts = [`${prefix}-db3.example`, `${prefix}-db1.example`, `${prefix}-db2.example`];
    for (const cn of [...longer, target]) await sql`INSERT INTO ipa_hosts.hostgroups (cn, description) VALUES (${cn}, ${`Gruppe ${cn}`})`;
    await sql`INSERT INTO ipa_hosts.hosts (fqdn, mac_address, ssh_fingerprints) VALUES (${hosts[1]!}, '{"AA:BB:CC:00:11:22"}', '{}')`;
    for (const fqdn of [hosts[0]!, hosts[2]!, `${prefix}-db1.example.longer`])
      await sql`INSERT INTO ipa_hosts.hosts (fqdn) VALUES (${fqdn})`;
    for (const fqdn of hosts) await sql`INSERT INTO ipa_hosts.host_hostgroups (host_fqdn, hostgroup_cn) VALUES (${fqdn}, ${target})`;
    await sql`INSERT INTO ipa_hosts.host_hostgroups (host_fqdn, hostgroup_cn) VALUES (${hosts[1]!}, ${longer[0]!})`;
    await sql`INSERT INTO ipa_hosts.hostgroup_hostgroups (parent_cn, child_cn) VALUES (${target}, ${longer[1]!})`;
    await sql`INSERT INTO ipa_hosts.hostgroup_hostgroups (parent_cn, child_cn) VALUES (${target}, ${longer[0]!})`;
    try {
      const search = await hostgroupListWithHosts({ search: `${prefix}-`, perPage: 50 });
      expect(search.hostgroups.some((group) => group.cn === target)).toBe(false);
      // a host's name finds the groups that hold it
      const byHost = await hostgroupListWithHosts({ search: `${prefix}-db2`, perPage: 50 });
      expect({ groups: byHost.hostgroups.map((group) => group.cn), total: byHost.total }).toEqual({ groups: [target], total: 1 });

      const sorted = [...hosts].sort();
      const meter = await meterSql();
      try {
        // one page of the group's hosts, in name order, with the number of all of them, in one statement
        let first: Awaited<ReturnType<typeof hostgroupGetWithHosts>> = null;
        expect(await meter.during(async () => (first = await hostgroupGetWithHosts(target, { page: 1, perPage: 2 })))).toHaveLength(1);
        expect(first).toMatchObject({ cn: target, hostgroups: [longer[0], longer[1]], hosts: sorted.slice(0, 2), hostTotal: 3 });
        expect(first!.hostDetails.map((host) => host.fqdn)).toEqual(sorted.slice(0, 2));
        const second = await hostgroupGetWithHosts(target, { page: 2, perPage: 2 });
        expect(second).toMatchObject({ hosts: sorted.slice(2), hostTotal: 3 });
        expect(second!.hostDetails.map((host) => host.fqdn)).toEqual(sorted.slice(2));

        // a host with its groups in name order, in one statement
        let host: Awaited<ReturnType<typeof hostGet>> = null;
        expect(await meter.during(async () => (host = await hostGet(hosts[1]!)))).toHaveLength(1);
        expect(host).toMatchObject({ fqdn: hosts[1], memberofHostgroup: [longer[0], target], macAddress: ["AA:BB:CC:00:11:22"] });
      } finally {
        await meter.close();
      }
      expect(await hostGet(`${prefix}-missing.example`)).toBeNull();
      expect(await hostgroupGetWithHosts(`${prefix}-missing`, { page: 1, perPage: 2 })).toBeNull();
    } finally {
      await sql`DELETE FROM ipa_hosts.hosts WHERE fqdn LIKE ${`${prefix}-%`}`;
      await sql`DELETE FROM ipa_hosts.hostgroups WHERE cn LIKE ${`${prefix}-%`}`;
    }
  });

  test("the figures count the hosts without SSH keys in the same one statement", async () => {
    await migrate();
    const prefix = `t${crypto.randomUUID().slice(0, 8)}`;
    const before = await hostStats();
    await sql`INSERT INTO ipa_hosts.hosts (fqdn, ssh_fingerprints) VALUES (${`${prefix}-a.example`}, '{}'), (${`${prefix}-b.example`}, '{}')`;
    await sql`INSERT INTO ipa_hosts.hosts (fqdn, ssh_fingerprints) VALUES (${`${prefix}-c.example`}, '{"SHA256:abc (ssh-ed25519)"}')`;
    const meter = await meterSql();
    try {
      let after: Awaited<ReturnType<typeof hostStats>> | null = null;
      expect(await meter.during(async () => (after = await hostStats()))).toHaveLength(1);
      expect(after!.hostsWithoutKeys - before.hostsWithoutKeys).toBe(2);
      expect(after!.firstWithoutKeys).not.toBeNull();
    } finally {
      await meter.close();
      await sql`DELETE FROM ipa_hosts.hosts WHERE fqdn LIKE ${`${prefix}-%`}`;
    }
  });
});
