import { render } from "solid-js/web";
import type { AgentKeyOpen, AgentKeySort } from "./agent-keys";
import { AgentScreenFixture, AgentsScreenFixture, worstAgent, worstKeys } from "./agent-screens.fixture";

/** The agent screens for a browser test: `<html data-state>` names the screen and its state; the test answers the API. */
type State =
  | { screen: "agents"; empty?: boolean }
  | { screen: "agent"; keys?: "sample" | "empty" | "failed" | "worst"; open?: AgentKeyOpen; sort?: AgentKeySort; active?: boolean };

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const state = JSON.parse(document.documentElement.dataset.state ?? "{}") as State;
render(
  () =>
    state.screen === "agents" ? (
      <AgentsScreenFixture empty={state.empty} />
    ) : (
      <AgentScreenFixture
        keys={state.keys === "empty" ? [] : state.keys === "failed" ? null : state.keys === "worst" ? worstKeys : undefined}
        agent={state.keys === "worst" ? worstAgent : undefined}
        open={state.open}
        sort={state.sort}
        active={state.active}
      />
    ),
  host,
);
