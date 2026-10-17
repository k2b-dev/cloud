import { clickhouseQuery, type QueryOptions } from "../../packages/pulse/src/store/client";
import { quoteIdentifier as q } from "../../packages/pulse/src/store/validation";
import { assertClickhouseTestPrefix, selectClickhouseTestNames } from "./test-clickhouse-selection";
import { clickhouseFixtureLoaded, requireInfraUrl } from "./test-infra";

(globalThis as { [clickhouseFixtureLoaded]?: boolean })[clickhouseFixtureLoaded] = true;

export const clickhouseTestPrefix = `pulsetest_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}_`;
export const clickhouseTestAdmin = () => {
  const url = new URL(requireInfraUrl("clickhouse"));
  const user = decodeURIComponent(url.username),
    password = decodeURIComponent(url.password);
  url.username = "";
  url.password = "";
  return { url: url.origin, user, password };
};
export const clickhouseAdminQuery = (query: string, opts: Partial<Pick<QueryOptions, "params" | "signal" | "timeoutMs">> = {}) =>
  clickhouseQuery({ ...clickhouseTestAdmin(), query, timeoutMs: 5_000, ...opts });

export const cleanupClickhouseTestObjects = async (): Promise<void> => {
  const prefix = clickhouseTestPrefix;
  assertClickhouseTestPrefix(prefix);
  // Row policies need both their name and exact table address.
  const policies = await clickhouseAdminQuery(
    "SELECT short_name AS name, database, table FROM system.row_policies WHERE startsWith(short_name, {prefix:String})",
    { params: { prefix } },
  );
  for (const row of policies) {
    if (
      typeof row.name !== "string" ||
      !selectClickhouseTestNames(prefix, [row.name]).length ||
      typeof row.database !== "string" ||
      typeof row.table !== "string"
    )
      continue;
    await clickhouseAdminQuery(`DROP ROW POLICY IF EXISTS ${q(row.name)} ON ${q(row.database)}.${q(row.table)}`);
  }
  for (const [source, kind] of [
    ["users", "USER"],
    ["roles", "ROLE"],
    ["quotas", "QUOTA"],
    ["settings_profiles", "SETTINGS PROFILE"],
    ["databases", "DATABASE"],
  ] as const) {
    const rows = await clickhouseAdminQuery(`SELECT name FROM system.${source} WHERE startsWith(name, {prefix:String})`, {
      params: { prefix },
    });
    const names = rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : []));
    for (const name of selectClickhouseTestNames(prefix, names)) await clickhouseAdminQuery(`DROP ${kind} IF EXISTS ${q(name)}`);
  }
};
