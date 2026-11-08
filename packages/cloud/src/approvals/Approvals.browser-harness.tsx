import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import Approvals from "./Approvals";

/** Renders the real list for a browser test, which answers the approvals API with invented requests. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const link = new URLSearchParams(location.search).get("link") ?? undefined;
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <Approvals app="assistant" link={link} />
    </LocaleProvider>
  ),
  host,
);
