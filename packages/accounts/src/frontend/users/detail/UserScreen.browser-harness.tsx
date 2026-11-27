import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import UserScreen from "./UserScreen";
import { type FixtureName, fixtureRecord } from "./user-record.fixture";
import { groupsPageFrom, userTabFrom } from "./user-view";

/**
 * A user's record for a browser test, rendered as the server renders it for the page's address: `?tab=` and
 * `?recursive=true` choose the area, `<html data-fixture>` the invented record. The test answers the API itself.
 */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const params = new URLSearchParams(location.search);
const recursive = params.get("recursive") === "true";
const fixture = (document.documentElement.dataset.fixture ?? "sample") as FixtureName;
const tab = userTabFrom(params.get("tab") ?? undefined, recursive);
const record = fixtureRecord(fixture, tab, { recursive, page: groupsPageFrom(params.get("page") ?? undefined) });
const list = params.get("list") ?? "";

render(
  () => (
    <LocaleProvider locale="de">
      <UserScreen
        record={record}
        tab={tab}
        recursive={recursive}
        list={list}
        listHref={list ? `/app/accounts/users?${list}` : "/app/accounts/users"}
        pendingRequests={2}
      />
    </LocaleProvider>
  ),
  host,
);

// how long the screen took from the page's answer until its rows stood, for the test of a huge record
const answered = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.responseEnd ?? 0;
document.documentElement.dataset.ready = String(Math.round(performance.now() - answered));
