import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import NotebooksOverview from "./NotebooksOverview";
import { overviewFixture } from "./notebooks-overview.fixture";

/** The overview for the browser test, with the sample the page's `data-sample` names (as the server would render it). */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const sample = document.documentElement.dataset.sample ?? "normal";

render(
  () => (
    <LocaleProvider locale="de">
      <NotebooksOverview {...overviewFixture({ worst: sample === "worst", empty: sample === "empty", more: true })} />
    </LocaleProvider>
  ),
  host,
);
