import { render } from "solid-js/web";
import type { AgentKeyOpen, AgentKeySort } from "./agent-keys";
import { AgentScreenFixture, AgentsScreenFixture, HUGE_TOTAL, hugeKeys } from "./agent-screens.fixture";

/** The agent screens for a browser test: `<html data-state>` names the screen and its state; the test answers the API. */
type State =
  | { screen: "agents"; empty?: boolean }
  | { screen: "agent"; keys?: "sample" | "empty" | "failed" | "huge"; open?: AgentKeyOpen; sort?: AgentKeySort; active?: boolean };

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
// the keys page of the address, as the record's server reads it
const page = Math.max(1, Number(new URLSearchParams(location.search).get("page")) || 1);
const state = JSON.parse(document.documentElement.dataset.state ?? "{}") as State;
render(
  () =>
    state.screen === "agents" ? (
      <AgentsScreenFixture empty={state.empty} />
    ) : (
      <AgentScreenFixture
        keys={state.keys === "empty" ? [] : state.keys === "failed" ? null : state.keys === "huge" ? hugeKeys(page) : undefined}
        total={state.keys === "huge" ? HUGE_TOTAL : undefined}
        page={page}
        open={state.open}
        sort={state.sort}
        active={state.active}
      />
    ),
  host,
);

// how long the screen took from the page's answer until its rows stood, for the test of a huge record
const answered = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.responseEnd ?? 0;
document.documentElement.dataset.ready = String(Math.round(performance.now() - answered));
