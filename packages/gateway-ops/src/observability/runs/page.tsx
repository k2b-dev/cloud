import { listApps } from "@k2b/cloud";
import { type AuthContext, getLocale, getTimeZone } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { observabilityAdminNav } from "../_components/admin-nav";
import { readAttention } from "../_components/ObservabilityArea";
import { jobsObservabilityService } from "../jobs/service";
import { syncOpsCredentials } from "../sync/service";
import RunsScreen from "./_components/RunsScreen.island";
import { runsMessages } from "./messages";
import { kindsOf, parseRunsAddress, RUNS_PER_PAGE, RUNS_PREVIEW, runsQuery } from "./query";
import { listRuns, readRunRecord } from "./service";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs: jobs, workflow runs, deliveries and dead letters in one list, and the schedules that start jobs. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = runsMessages.resolve([locale]);
  const url = new URL(c.req.url);
  const credentials = syncOpsCredentials(c.req.raw);
  const registered = await listApps().catch(() => []);
  const apps = registered.map((app) => ({ id: app.id, label: app.name || app.id }));
  const query = runsQuery(locale, apps, url.searchParams.get("app") ?? undefined);
  const address = parseRunsAddress(query, url.searchParams);
  const kinds = kindsOf(address.state);
  const now = new Date();

  const [parts, record, schedules, attention] = await Promise.all([
    address.tab === "runs"
      ? listRuns(address.state, kinds, { page: address.page, perPage: RUNS_PER_PAGE, preview: RUNS_PREVIEW, credentials, now })
      : Promise.resolve([]),
    address.run
      ? readRunRecord(address.run)
          .then((value) => ({ record: value, error: null }))
          .catch((error: unknown) => ({ record: null, error: message(error) }))
      : Promise.resolve(null),
    address.tab === "schedules"
      ? jobsObservabilityService
          .listSchedules(credentials)
          .then((value) => ({ ...value, error: null }))
          .catch((error: unknown) => ({ schedules: [], warnings: [], error: message(error) }))
      : Promise.resolve(null),
    readAttention(),
  ]);

  const ignored =
    address.issues.length > 0
      ? t.ignoredPartsDetail({ params: address.issues.map((issue) => (issue.param ? `${issue.param}=${issue.value}` : issue.code)).join(", ") })
      : null;
  return () => (
    <AdminLayout c={c} ui="v2" title={t.runs}>
      <RunsScreen
        nav={observabilityAdminNav(c, locale, attention, "runs")}
        apps={apps}
        timeZone={getTimeZone(c)}
        now={now.toISOString()}
        state={address.state}
        page={address.page}
        run={address.run}
        tab={address.tab}
        ignored={ignored}
        parts={parts}
        record={record}
        schedules={schedules}
      />
    </AdminLayout>
  );
});
