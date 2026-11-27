import { render } from "solid-js/web";
import { OverviewScreenFixture } from "./OverviewScreen.browser-fixture";

/** The overview for a browser test: it renders the address and data set as the page would. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const state = document.documentElement.dataset.state;
const data = state === "worst" || state === "quiet" ? state : "normal";
render(() => <OverviewScreenFixture search={location.search} locale={document.documentElement.lang} data={data} />, host);
document.body.dataset.ready = "true";
