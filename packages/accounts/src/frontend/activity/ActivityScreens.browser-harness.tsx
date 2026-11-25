import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { ActivityFixture } from "./activity-screens.fixture";

/** The activity screens for a browser test: `<html data-state>` names the sample; the address names the screen. */
type State = { worst?: boolean; status?: "draft" | "running" | "completed_with_errors" };

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const state = JSON.parse(document.documentElement.dataset.state ?? "{}") as State;
render(
  () => (
    <LocaleProvider locale="de">
      <ActivityFixture worst={state.worst} status={state.status} />
    </LocaleProvider>
  ),
  host,
);
