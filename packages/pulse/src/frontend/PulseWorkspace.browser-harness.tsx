import { LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
import { render } from "solid-js/web";
import PulseOverview from "./PulseOverview.island";
import PulseWorkspace from "./PulseWorkspace.island";
import type { PulseWorkspaceProps } from "./workspace/types";

// The browser test passes the server snapshot and the locale in the page's own script tag: a base page, or the
// overview when `overview` is set.
const snapshot = (
  window as unknown as { __pulse: { locale: string; props: PulseWorkspaceProps; overview?: ComponentProps<typeof PulseOverview> } }
).__pulse;
const root = document.getElementById("root");
if (!root) throw new Error("Missing harness root");
const overview = snapshot.overview;
render(
  () => (
    <LocaleProvider locale={snapshot.locale}>
      {overview ? <PulseOverview {...overview} /> : <PulseWorkspace {...snapshot.props} />}
    </LocaleProvider>
  ),
  root,
);
