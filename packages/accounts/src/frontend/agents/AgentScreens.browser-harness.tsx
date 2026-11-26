import { render } from "solid-js/web";
import { AgentScreenFixture, AgentsScreenFixture, type KeysState } from "./agent-screens.fixture";

/** The agent screens for a browser test: `<html data-state>` names the screen and its state; the test answers the API. */
type State = { screen: "agents"; empty?: boolean } | { screen: "agent"; keys?: KeysState; active?: boolean };

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const state = JSON.parse(document.documentElement.dataset.state ?? "{}") as State;
render(
  () =>
    state.screen === "agents" ? (
      <AgentsScreenFixture empty={state.empty} />
    ) : (
      <AgentScreenFixture keys={state.keys} active={state.active} />
    ),
  host,
);

// how long the screen took from the page's answer until its rows stood, for the test of a huge record
const answered = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.responseEnd ?? 0;
document.documentElement.dataset.ready = String(Math.round(performance.now() - answered));
