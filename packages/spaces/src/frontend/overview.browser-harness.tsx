import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import {
  OVERVIEW_DATES,
  OVERVIEW_NOW,
  overviewActivity,
  overviewSpaces,
  overviewWork,
  overviewWorstActivity,
  overviewWorstSpaces,
  overviewWorstWork,
} from "./overview.fixture";
import SpacesOverview from "./SpacesOverview.island";

/** The Spaces home for a browser test, as the page renders it for the address; `data-state="worst"` takes the worst case. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const worst = document.documentElement.dataset.state === "worst";
const view = new URL(location.href).searchParams.get("view");
const initialView = view === "today" || view === "upcoming" ? view : "mine";
const locale = document.documentElement.lang;
render(
  () => (
    <LocaleProvider locale={locale}>
      <SpacesOverview
        spaces={worst ? overviewWorstSpaces : overviewSpaces}
        initialView={initialView}
        initialPinnedSpaceIds={["Space1"]}
        initialWork={{ ...(worst ? overviewWorstWork : overviewWork), view: initialView }}
        initialActivity={{ items: worst ? overviewWorstActivity : overviewActivity, nextCursor: "next" }}
        initialActivityError={null}
        dateConfig={{ ...OVERVIEW_DATES, locale }}
        now={OVERVIEW_NOW}
      />
    </LocaleProvider>
  ),
  host,
);
document.body.dataset.ready = "true";
