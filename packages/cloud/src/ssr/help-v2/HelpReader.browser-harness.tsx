import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { HelpReader } from "./HelpReader";
import { helpReaderFixture, worstCaseHelpReaderFixture } from "./help-reader.fixture";

/**
 * The v2 Help reader for a browser test, as the app's Help route renders it (`/help/apps/spaces/<topic>` opens an
 * article as the server would). `?worst` shows the worst case.
 */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const params = new URLSearchParams(location.search);
const topic = location.pathname.split("/")[4] || undefined;
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <HelpReader
        {...helpReaderFixture}
        {...(params.has("worst") ? worstCaseHelpReaderFixture : {})}
        initialTopic={topic}
        initialArticle={topic === "share" ? helpReaderFixture.initialArticle : undefined}
      />
    </LocaleProvider>
  ),
  host,
);
