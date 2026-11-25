import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { HelpReader } from "./HelpReader";
import { helpReaderFixture, worstCaseHelpReaderFixture } from "./help-reader.fixture";

/**
 * The v2 Help reader for a browser test, as the panel's provider page renders it. `?worst` shows the worst case,
 * `?page` the full-page reader on the app's Help route; `?topic=` opens an article as the server would.
 */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const params = new URLSearchParams(location.search);
const page = location.pathname.startsWith("/help/apps/");
const topic = page ? location.pathname.split("/")[4] : (params.get("topic") ?? undefined);
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <HelpReader
        {...helpReaderFixture}
        {...(params.has("worst") ? worstCaseHelpReaderFixture : {})}
        surface={page ? "page" : "panel"}
        initialTopic={topic}
        initialArticle={topic === "share" ? helpReaderFixture.initialArticle : undefined}
      />
    </LocaleProvider>
  ),
  host,
);
