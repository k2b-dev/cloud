import { render } from "solid-js/web";
import { RunsScreenFixture } from "./runs-fixture";

/** The runs list for a browser test: it renders the address as the page would; the test answers the list API. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
render(() => <RunsScreenFixture search={location.search} locale={document.documentElement.lang} />, host);
document.body.dataset.ready = "true";
