import { type AuthContext, getLocale, getTimeZone } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { areaText, observabilityGroups, readAttention } from "../_components/ObservabilityArea";
import ObservabilityNavigation from "../_components/ObservabilityNavigation.island";
import LogsScreen from "./_components/LogsScreen.island";
import { logsMessages } from "./messages";
import { isLogView, LOG_VIEWS, legacyLogsHref, logSearchOf, logsHref, logsQuery, parseLogsAddress } from "./query";
import { logRowFormatter } from "./rows";
import { loggingService } from "./service";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The log list on v2. Its address is the whole state: the declaration in `query.ts` reads it, the service filters. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const timeZone = getTimeZone(c);
  const url = new URL(c.req.url);
  // Addresses from before v2 (window, search, one source per parameter) lead to the same list in the v2 address.
  const legacy = legacyLogsHref(url.searchParams);
  if (legacy) return c.redirect(legacy);

  const query = logsQuery(locale);
  const address = parseLogsAddress(query, url.searchParams);
  const view = address.state.view;
  const issues = [...address.issues];
  if (view !== undefined && !isLogView(view)) issues.push({ code: "invalid", param: "view", value: view });
  // A view named alone opens with its whole query, so the address always holds the state.
  if (isLogView(view) && [...url.searchParams.keys()].every((name) => name === "view")) return c.redirect(logsHref(query, LOG_VIEWS[view](query)));
  const state = isLogView(view) ? address.state : { ...address.state, view: undefined };

  const now = new Date();
  // A log store that is down degrades the list, not the page: the operator still needs the area to find out why.
  const [list, attention, selected] = await Promise.all([
    loggingService.entry
      .search(logSearchOf(state, now), address.page)
      .then((data) => ({ data, error: null }))
      .catch((error: unknown) => ({ data: null, error: message(error) })),
    readAttention(),
    address.entry
      ? loggingService.entry
          .get({ id: address.entry })
          .then((entry) => ({ entry, error: null }))
          .catch((error: unknown) => ({ entry: null, error: message(error) }))
      : Promise.resolve(null),
  ]);

  const { t } = logsMessages.resolve([locale]);
  const area = areaText(locale);
  const groups = observabilityGroups(c, locale, attention);
  const ignored =
    issues.length > 0
      ? t.ignoredPartsDetail({ params: issues.map((issue) => (issue.param ? `${issue.param}=${issue.value}` : issue.code)).join(", ") })
      : null;
  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: area.area, href: "/admin/observability" }, { title: t.logs }]}>
      <ObservabilityNavigation label={area.area} current="logs" groups={groups} />
      <LogsScreen
        timeZone={timeZone}
        today={logRowFormatter(locale, timeZone).today(now)}
        area={{ title: area.area, groups, markLabel: area.needsAttention }}
        state={state}
        page={address.page}
        entry={address.entry}
        liveOff={address.liveOff}
        ignored={ignored}
        data={list.data}
        error={list.error}
        selected={selected}
      />
    </Layout>
  );
});

