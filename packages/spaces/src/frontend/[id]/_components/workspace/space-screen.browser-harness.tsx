import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import SpaceScreen from "./SpaceScreen";
import { type SpaceFixtureState, spaceScreenProps } from "./space-screen.fixture";

/** A Space on v2 for a browser test, as the page renders it for the address; `data-state` picks the fixture state. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const states: SpaceFixtureState[] = ["usual", "worst", "huge", "empty"];
const state = states.find((entry) => entry === document.documentElement.dataset.state) ?? "usual";
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang}>
      <SpaceScreen {...spaceScreenProps(`${location.pathname}${location.search}`, state)} />
    </LocaleProvider>
  ),
  host,
);
document.body.dataset.ready = "true";
