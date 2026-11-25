import { render } from "solid-js/web";
import { LogsScreenFixture } from "./logs-screen.fixture";

/** The log list for a browser test: it renders the address as the page would; the test answers the list API. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const state = document.documentElement.dataset.state === "loadfail" ? "loadfail" : "normal";
const fixture = document.documentElement.dataset.fixture === "worst" ? "worst" : undefined;
render(() => <LogsScreenFixture search={location.search} locale={document.documentElement.lang} state={state} fixture={fixture} />, host);
document.body.dataset.ready = "true";
