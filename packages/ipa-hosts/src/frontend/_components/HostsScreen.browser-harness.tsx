import { render } from "solid-js/web";
import { HostsFixture } from "./hosts-fixture";

/** The Hosts screen for a browser test: `data-state` names the data set; the address is the page's. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const state = document.documentElement.dataset.state;
const data = state === "worst" || state === "empty" ? state : "normal";
render(() => <HostsFixture search={location.search} data={data} />, host);
document.body.dataset.ready = "true";
