import { render } from "solid-js/web";
import { PagesFixture, type PagesFixtureScreen } from "./pages-v2-fixture";

/** One screen for a browser test: `data-screen` names it, `data-state` the data set; the address is the page's. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const screens: PagesFixtureScreen[] = ["routes", "registry", "legacy", "capabilities"];
const screen = screens.find((value) => value === document.documentElement.dataset.screen) ?? "routes";
const data = document.documentElement.dataset.state === "worst" ? "worst" : "normal";
render(() => <PagesFixture screen={screen} search={location.search} data={data} />, host);
document.body.dataset.ready = "true";
