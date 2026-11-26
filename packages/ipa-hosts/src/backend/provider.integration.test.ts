import { expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { hostGet, hostgroupGetWithHosts, hostgroupListWithHosts } from "./provider";

suiteFor("database")("the host mirror's records", () => {
  test("a host and a host group are read by their exact name in one statement, behind any number of longer names", async () => {
    await migrate();
    const prefix = `t${crypto.randomUUID().slice(0, 8)}`;
    const target = `${prefix}-server`;
    // 60 groups whose names contain the target's and sort before it: a substring search with a limit would miss it
    const longer = Array.from({ length: 60 }, (_, index) =>
      `${prefix}-server-${String(index).padStart(2, "0")}`.replace("-server-", "-a-server-"),
    );
    for (const cn of [...longer, target]) await sql`INSERT INTO ipa_hosts.hostgroups (cn, description) VALUES (${cn}, ${`Gruppe ${cn}`})`;
    await sql`INSERT INTO ipa_hosts.hosts (fqdn, mac_address, ssh_fingerprints) VALUES (${`${prefix}-db1.example`}, '{"AA:BB:CC:00:11:22"}', '{}')`;
    await sql`INSERT INTO ipa_hosts.hosts (fqdn) VALUES (${`${prefix}-db1.example.longer`})`;
    await sql`INSERT INTO ipa_hosts.host_hostgroups (host_fqdn, hostgroup_cn) VALUES (${`${prefix}-db1.example`}, ${target})`;
    await sql`INSERT INTO ipa_hosts.hostgroup_hostgroups (parent_cn, child_cn) VALUES (${target}, ${longer[0]!})`;
    try {
      const search = await hostgroupListWithHosts({ search: `${prefix}-`, perPage: 50 });
      expect(search.hostgroups.some((group) => group.cn === target)).toBe(false);

      const meter = await meterSql();
      try {
        let group: Awaited<ReturnType<typeof hostgroupGetWithHosts>> = null;
        expect(await meter.during(async () => (group = await hostgroupGetWithHosts(target)))).toHaveLength(1);
        expect(group).toMatchObject({ cn: target, hostgroups: [longer[0]], hosts: [`${prefix}-db1.example`] });
        let host: Awaited<ReturnType<typeof hostGet>> = null;
        expect(await meter.during(async () => (host = await hostGet(`${prefix}-db1.example`)))).toHaveLength(1);
        expect(host).toMatchObject({ fqdn: `${prefix}-db1.example`, memberofHostgroup: [target], macAddress: ["AA:BB:CC:00:11:22"] });
      } finally {
        await meter.close();
      }
      expect(await hostGet(`${prefix}-missing.example`)).toBeNull();
      expect(await hostgroupGetWithHosts(`${prefix}-missing`)).toBeNull();
    } finally {
      await sql`DELETE FROM ipa_hosts.hosts WHERE fqdn LIKE ${`${prefix}-%`}`;
      await sql`DELETE FROM ipa_hosts.hostgroups WHERE cn LIKE ${`${prefix}-%`}`;
    }
  });
});
