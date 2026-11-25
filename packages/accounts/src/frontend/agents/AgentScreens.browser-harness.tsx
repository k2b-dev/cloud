import { render } from "solid-js/web";
import type { AgentKeyOpen, AgentKeySort } from "./agent-keys";
import { AgentScreenFixture } from "./agent-screens.fixture";

/** The agent screen for a browser test: `<html data-state>` names its state; the test answers the API. */
type State = { screen: "agent"; keys?: "sample" | "empty" | "failed"; open?: AgentKeyOpen; sort?: AgentKeySort; active?: boolean };

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const state = JSON.parse(document.documentElement.dataset.state ?? "{}") as State;
render(
  () => (
    <AgentScreenFixture
      keys={state.keys === "empty" ? [] : state.keys === "failed" ? null : undefined}
      open={state.open}
      sort={state.sort}
      active={state.active}
    />
  ),
  host,
);
