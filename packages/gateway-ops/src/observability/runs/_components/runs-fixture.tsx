import { LocaleProvider } from "@k2b/ui";
import type { NavProps } from "@k2b/ui/v2";
import { parseRunsAddress, runsQuery } from "../query";
import RunsScreen from "./RunsScreen";
import { FIXTURE_APPS, fixtureJobRecord, fixtureParts, fixtureSchedules } from "./runs-fixture-data";

const nav: NavProps = {
  title: "Administration",
  icon: "settings",
  groups: [{ items: [{ label: "Läufe", icon: "player-play", href: "/admin/observability/runs", current: true }] }],
};

/** The screen for one address, as the page renders it. */
export const RunsScreenFixture = (props: { search: string; locale?: string }) => {
  const query = runsQuery(props.locale ?? "de", FIXTURE_APPS);
  const address = parseRunsAddress(query, new URLSearchParams(props.search));
  return (
    <LocaleProvider locale={props.locale ?? "de"}>
      <RunsScreen
        nav={nav}
        apps={FIXTURE_APPS}
        timeZone="Europe/Berlin"
        now="2026-11-24T09:44:10.000Z"
        state={address.state}
        page={address.page}
        run={address.run}
        tab={address.tab}
        ignored={address.issues.length ? address.issues.map((issue) => `${issue.param}=${issue.value}`).join(", ") : null}
        parts={address.tab === "runs" ? fixtureParts(props.search, address.page) : []}
        record={address.run ? { record: address.run.kind === "job" ? fixtureJobRecord : null, error: null } : null}
        names={
          address.state.filters.workflow
            ? { workflow: [{ value: address.state.filters.workflow, label: "Neue Anfrage zuordnen", meta: "mail" }] }
            : undefined
        }
        schedules={address.tab === "schedules" ? { schedules: fixtureSchedules, warnings: [], error: null } : null}
      />
    </LocaleProvider>
  );
};
