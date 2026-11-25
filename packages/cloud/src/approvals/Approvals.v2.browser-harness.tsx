import { LocaleProvider } from "@k2b/ui";
import { Bar, Pane, Text, Workspace } from "@k2b/ui/v2";
import { render } from "solid-js/web";
import type { ApprovalPage } from "../contracts/approvals";
import Approvals from "./Approvals";

/**
 * The v2 list as a v2 page hosts it: the content of the page's `Pane`. The test puts the first page into the document
 * (as the server would with `loadPendingApprovals`) and answers the approvals API with invented requests.
 */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const params = new URLSearchParams(location.search);
const initial = JSON.parse(document.getElementById("initial")?.textContent || "null") as ApprovalPage | null;
const locale = document.documentElement.lang || "en";
render(
  () => (
    <LocaleProvider locale={locale}>
      <Workspace head={<Bar start={<Text>{locale === "de" ? "Freigaben" : "Approvals"}</Text>} />}>
        <Pane label={locale === "de" ? "Freigaben" : "Approvals"}>
          <Approvals ui="v2" app={params.get("app") ?? undefined} link={params.get("link") ?? undefined} initial={initial ?? undefined} />
        </Pane>
      </Workspace>
    </LocaleProvider>
  ),
  host,
);
