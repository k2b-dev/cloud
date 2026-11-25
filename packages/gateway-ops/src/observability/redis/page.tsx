import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { formatNumber, formatPercent } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { gatewayOpsMessages } from "../../messages";
import { areaText, observabilityGroups, readAttention } from "../_components/ObservabilityArea";
import ObservabilityNavigation from "../_components/ObservabilityNavigation.island";
import { opsCharts } from "../_components/ops-chart";
import { getRedisDiagnostics } from "../data/service";
import { valkeyCells } from "../infrastructure/sections";
import ValkeyScreen from "./_components/ValkeyScreen.island";
import { legacyValkeyHref, valkeyHref, valkeyQuery } from "./query";

/** Valkey on v2. The address holds the prefix depth and the search; the page filters the sampled prefixes. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const url = new URL(c.req.url);
  const legacy = legacyValkeyHref(url.searchParams);
  if (legacy) return c.redirect(legacy);
  const query = valkeyQuery(locale);
  const address = query.parse(url.searchParams);
  const state = address.state;
  const depth = Number(state.filters.depth);
  const [diagnostics, attention] = await Promise.all([getRedisDiagnostics(locale), readAttention()]);
  const needle = state.search?.trim().toLowerCase() ?? "";
  const number = (value: number) => formatNumber(value, { locale });

  const prefixes = diagnostics.prefixes.filter(
    (prefix) => prefix.depth === depth && (!needle || prefix.prefix.toLowerCase().includes(needle)),
  );
  const chartData = prefixes
    .slice()
    .sort((left, right) => right.count - left.count || left.prefix.localeCompare(right.prefix))
    .slice(0, 10)
    .map((prefix) => ({ label: prefix.prefix, value: prefix.count }));
  const cells = valkeyCells(diagnostics, locale);
  const sampled = diagnostics.scanComplete
    ? t.keysScanned({ count: number(diagnostics.sampledKeys) })
    : t.keysSampled({ count: number(diagnostics.sampledKeys), total: number(diagnostics.dbSize) });
  const ignored = address.issues.length > 0 ? address.issues.map((issue) => `${issue.param}=${issue.value}`).join(", ") : null;
  const area = areaText(locale);
  const groups = observabilityGroups(c, locale, attention);

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[{ title: t.start, href: "/" }, { title: area.area, href: "/admin/observability" }, { title: area.valkey }]}
    >
      <ObservabilityNavigation label={area.area} current="valkey" groups={groups} />
      <ValkeyScreen
        area={{ title: area.area, groups, markLabel: area.needsAttention }}
        state={state}
        ignored={ignored}
        cells={cells}
        warnings={diagnostics.warnings.map((warning) => ({
          tone: warning.tone === "red" ? "bad" : "warn",
          title: warning.title,
          text: warning.detail,
        }))}
        error={diagnostics.available ? null : diagnostics.error}
        chart={opsCharts([{ kind: "bar", title: t.prefixDistribution, description: sampled, data: chartData }], locale)[0]!}
        sampled={sampled}
        prefixes={prefixes.map((prefix) => ({
          key: `${prefix.depth}:${prefix.prefix}`,
          prefix: prefix.prefix,
          depth: String(prefix.depth),
          count: number(prefix.count),
          share: formatPercent(prefix.share || 0, { locale }),
          // A prefix opens the next depth under it.
          href:
            depth < 3 ? valkeyHref(query, { ...state, filters: { depth: String(depth + 1) as "2" | "3" }, search: prefix.prefix }) : null,
        }))}
      />
    </Layout>
  );
});
